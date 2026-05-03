#!/usr/bin/env node
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const DEFAULT_ROOT = "export-wiznotes";
const GUID_RE = /[0-9a-fA-F-]{36}/;
const FRONTMATTER_GUID_RE = /^wiznote_doc_guid:\s*"([0-9a-fA-F-]{36})"/m;
const BROKEN_WIKILINK_RE = /\[\[([^\]\n]*?)\sid=([0-9a-fA-F-]{36})\]\]/g;

function usage() {
  return `Usage:
  node scripts/fix-wiznote-links.js [ROOT_DIR] [--dry-run]

Options:
  --dry-run   Report changes without writing files
`;
}

function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  let dryRun = false;

  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    root = arg;
  }

  return {
    dryRun,
    root: path.resolve(process.cwd(), root),
  };
}

function toPortablePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function noteTargetFromPath(root, filePath) {
  return toPortablePath(path.relative(root, filePath)).replace(/\.md$/i, "");
}

function noteBaseName(target) {
  const parts = target.split("/");
  return parts[parts.length - 1];
}

function normalizeDisplayText(rawText) {
  return String(rawText || "").trim().replace(/\\_/g, "_");
}

async function walkMarkdownFiles(root) {
  const results = [];
  const stack = [root];

  while (stack.length) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && (entry.name === ".git" || entry.name === ".obsidian")) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) results.push(fullPath);
    }
  }

  return results.sort();
}

async function buildNoteIndex(root, files) {
  const guidToNote = new Map();
  const baseNameCounts = new Map();

  for (const filePath of files) {
    const text = await fsp.readFile(filePath, "utf8");
    const guidMatch = text.match(FRONTMATTER_GUID_RE);
    if (!guidMatch) continue;

    const target = noteTargetFromPath(root, filePath);
    const basename = noteBaseName(target);
    baseNameCounts.set(basename, (baseNameCounts.get(basename) || 0) + 1);
    guidToNote.set(guidMatch[1].toLowerCase(), {
      basename,
      filePath,
      target,
    });
  }

  return { guidToNote, baseNameCounts };
}

function replacementForLink(note, baseNameCounts, rawTitle) {
  const displayText = normalizeDisplayText(rawTitle);
  const target = (baseNameCounts.get(note.basename) || 0) > 1 ? note.target : note.basename;
  if (displayText === note.basename) return `[[${target}]]`;
  return `[[${target}|${displayText}]]`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(args.root) || !fs.statSync(args.root).isDirectory()) {
    throw new Error(`Root directory not found: ${args.root}`);
  }

  const files = await walkMarkdownFiles(args.root);
  const { guidToNote, baseNameCounts } = await buildNoteIndex(args.root, files);
  const stats = {
    filesScanned: files.length,
    filesChanged: 0,
    notesIndexed: guidToNote.size,
    duplicateBasenames: [...baseNameCounts.values()].filter((count) => count > 1).length,
    linksFound: 0,
    linksRewritten: 0,
    unresolvedLinks: 0,
  };
  const unresolvedSamples = [];

  for (const filePath of files) {
    const original = await fsp.readFile(filePath, "utf8");
    let fileChanged = false;
    const updated = original.replace(BROKEN_WIKILINK_RE, (match, rawTitle, guid) => {
      stats.linksFound += 1;
      const note = guidToNote.get(String(guid).toLowerCase());
      if (!note) {
        stats.unresolvedLinks += 1;
        if (unresolvedSamples.length < 20) {
          unresolvedSamples.push({
            file: toPortablePath(path.relative(args.root, filePath)),
            guid,
            link: match,
          });
        }
        return match;
      }

      const replacement = replacementForLink(note, baseNameCounts, rawTitle);
      if (replacement !== match) {
        stats.linksRewritten += 1;
        fileChanged = true;
      }
      return replacement;
    });

    if (!fileChanged) continue;
    stats.filesChanged += 1;
    if (!args.dryRun) await fsp.writeFile(filePath, updated, "utf8");
  }

  const mode = args.dryRun ? "dry-run" : "write";
  console.log(JSON.stringify({
    mode,
    root: args.root,
    stats,
    unresolvedSamples,
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
