#!/usr/bin/env node
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const DEFAULT_ROOT = "export-wiznotes";
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HEX_COLOR_RE = /^[0-9A-Fa-f]{6}$/;
const CPP_MACRO_RE = /^(include|define|ifdef|ifndef|endif|pragma|undef|elif|if|else)$/i;
const TAG_LIKE_WORD_RE =
  /^(d|date|clock|released|packages|name|baseurl|gpgcheck|gpgkey|additional|logging|return|target|mlock|maximum|layename|avoid|find[\w.-]*|print[\w.-]*|syncwiki[\w.-]*|force[\w.-]*)$/i;
const FENCE_RE = /^\s*(```+|~~~+)/;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const LINK_LABEL_RE = /\[(#[^\]\n]+)\]\(/g;
const STRAY_LINE_ANCHOR_RE = /\)#(L\d+\b)/g;
const INLINE_TAG_RE = /(^|[ \t|>=(\u00A0])#([^\s#<>()\[\]{}"'`|=]+)/g;

function usage() {
  return `Usage:
  node scripts/clean-obsidian-tags.js [ROOT_DIR] [--dry-run]

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

function stripYamlQuotes(value) {
  const text = String(value || "").trim();
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function hasHan(value) {
  return /[\p{Script=Han}]/u.test(value);
}

function shouldEscapeToken(token) {
  const value = String(token || "").trim().replace(/[.,;:!?]+$/g, "");
  if (!value) return false;
  if (UUID_RE.test(value)) return true;
  if (HEX_COLOR_RE.test(value)) return true;
  if (CPP_MACRO_RE.test(value)) return true;
  if (/^L\d+$/i.test(value)) return true;
  if (hasHan(value)) return true;
  return TAG_LIKE_WORD_RE.test(value);
}

function shouldEscapeAfterHash(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (hasHan(value)) return true;
  return TAG_LIKE_WORD_RE.test(value);
}

function splitFrontmatter(text) {
  const match = String(text || "").match(FRONTMATTER_RE);
  if (!match) return null;
  return {
    body: text.slice(match[0].length),
    frontmatter: match[1],
    raw: match[0],
  };
}

function cleanFrontmatter(text, stats) {
  const split = splitFrontmatter(text);
  if (!split) return { changed: false, text };

  const lines = split.frontmatter.split("\n");
  const output = [];
  let changed = false;

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== "tags:") {
      output.push(lines[i]);
      continue;
    }

    const kept = [];
    let removedAny = false;
    let sawAny = false;
    let j = i + 1;
    while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
      sawAny = true;
      const rawValue = lines[j].replace(/^\s+-\s+/, "");
      const value = stripYamlQuotes(rawValue);
      if (!value || UUID_RE.test(value)) {
        if (value && UUID_RE.test(value)) stats.frontmatterUuidTagsRemoved += 1;
        removedAny = true;
      } else {
        kept.push(lines[j]);
      }
      j += 1;
    }

    if (kept.length) {
      output.push("tags:");
      output.push(...kept);
    } else {
      stats.frontmatterTagBlocksRemoved += 1;
      if (sawAny || !sawAny) changed = true;
    }
    if (removedAny) changed = true;
    i = j - 1;
  }

  if (!changed) return { changed: false, text };
  const normalizedBody = split.body.replace(/^\n+/, "");
  const nextText = `---\n${output.join("\n")}\n---\n\n${normalizedBody}`;
  return { changed: nextText !== text, text: nextText };
}

function cleanBody(text, stats) {
  const split = splitFrontmatter(text);
  const prefix = split ? `---\n${split.frontmatter}\n---\n\n` : "";
  const body = split ? split.body.replace(/^\n+/, "") : String(text || "");
  const lines = body.split("\n");
  let insideFence = false;
  let changed = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;

    let next = line.replace(LINK_LABEL_RE, (match, label) => {
      if (!shouldEscapeToken(label.slice(1))) return match;
      stats.linkLabelsEscaped += 1;
      return `[\\${label}](`;
    });

    next = next.replace(STRAY_LINE_ANCHOR_RE, (match, anchor) => {
      stats.strayLineAnchorsEscaped += 1;
      return `)\\#${anchor}`;
    });

    next = next.replace(/(^|[ \t])#([^\n]*)$/g, (match, prefixPart, rest) => {
      if (!shouldEscapeAfterHash(rest)) return match;
      stats.inlineHashesEscaped += 1;
      return `${prefixPart}\\#${rest}`;
    });

    next = next.replace(/(^|[ \t])#(-{3,}.*)$/g, (match, prefixPart, rest) => {
      stats.inlineHashesEscaped += 1;
      return `${prefixPart}\\#${rest}`;
    });

    next = next.replace(/(\*\*)#([^*\n]+)(\*\*)/g, (match, open, content, close) => {
      if (!shouldEscapeAfterHash(content)) return match;
      stats.inlineHashesEscaped += 1;
      return `${open}\\#${content}${close}`;
    });

    next = next.replace(INLINE_TAG_RE, (match, prefixPart, token) => {
      if (!shouldEscapeToken(token)) return match;
      stats.inlineHashesEscaped += 1;
      return `${prefixPart}\\#${token}`;
    });

    if (next !== line) {
      lines[i] = next;
      changed = true;
    }
  }

  if (!changed) return { changed: false, text };
  return {
    changed: true,
    text: prefix + lines.join("\n"),
  };
}

async function walkMarkdownFiles(root) {
  const results = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
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

async function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(args.root) || !fs.statSync(args.root).isDirectory()) {
    throw new Error(`Root directory not found: ${args.root}`);
  }

  const stats = {
    filesChanged: 0,
    filesScanned: 0,
    frontmatterTagBlocksRemoved: 0,
    frontmatterUuidTagsRemoved: 0,
    inlineHashesEscaped: 0,
    linkLabelsEscaped: 0,
    strayLineAnchorsEscaped: 0,
  };

  const files = await walkMarkdownFiles(args.root);
  for (const filePath of files) {
    stats.filesScanned += 1;
    const original = await fsp.readFile(filePath, "utf8");
    const frontmatterCleaned = cleanFrontmatter(original, stats);
    const bodyCleaned = cleanBody(frontmatterCleaned.text, stats);
    if (!frontmatterCleaned.changed && !bodyCleaned.changed) continue;
    stats.filesChanged += 1;
    if (!args.dryRun) await fsp.writeFile(filePath, bodyCleaned.text, "utf8");
  }

  const mode = args.dryRun ? "dry-run" : "write";
  console.log(JSON.stringify({ mode, root: args.root, stats }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
