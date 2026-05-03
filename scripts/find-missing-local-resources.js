#!/usr/bin/env node
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const DEFAULT_ROOT = "export-wiznotes";
const DEFAULT_FORMAT = "markdown";
const DEFAULT_LOG_FILE = "find-missing-local-resources.log";
const FENCE_RE = /^\s*(```+|~~~+)/;
const OBSIDIAN_EMBED_RE = /!\[\[([^\]\n]+)\]\]/g;
const OBSIDIAN_LINK_RE = /(?<!!)\[\[([^\]\n]+)\]\]/g;
const MARKDOWN_IMAGE_RE = /!\[[^\]\n]*\]\(([^)\n]+)\)/g;
const MARKDOWN_LINK_RE = /(?<!!)\[[^\]\n]+\]\(([^)\n]+)\)/g;
const ESCAPED_MARKDOWN_CHAR_RE = /\\([\\`*_{}\[\]()#+\-.!])/g;
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WINDOWS_ABS_RE = /^[A-Za-z]:\\/;
const UNC_PATH_RE = /^\\\\/;

const ATTACHMENT_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".ico",
  ".heic",
  ".avif",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".txt",
  ".csv",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".mdx",
  ".mp3",
  ".m4a",
  ".wav",
  ".flac",
  ".ogg",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".js",
  ".ts",
  ".css",
  ".py",
  ".sh",
]);

const execFileAsync = promisify(execFile);

function usage() {
  return `Usage:
  node scripts/find-missing-local-resources.js [ROOT_DIR]
  node scripts/find-missing-local-resources.js --root ROOT_DIR [--format markdown|json] [--fix-moved] [--dry-run]

Options:
  --root PATH          Vault root to scan. Defaults to export-wiznotes
  --format FORMAT      Output format: markdown or json. Defaults to markdown
  --fix-moved          Move detected moved resource directories back beside the Markdown note
  --dry-run            Show planned fix commands without executing them
  --log-file PATH      Log file path. Defaults to ROOT_DIR/find-missing-local-resources.log
  --help, -h           Show this help message
`;
}

function parseArgs(argv) {
  let root = null;
  let format = DEFAULT_FORMAT;
  let fixMoved = false;
  let dryRun = false;
  let logFile = null;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--root") {
      i += 1;
      if (i >= argv.length) throw new Error("--root requires a value");
      root = argv[i];
      continue;
    }
    if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
      continue;
    }
    if (arg === "--format") {
      i += 1;
      if (i >= argv.length) throw new Error("--format requires a value");
      format = argv[i];
      continue;
    }
    if (arg.startsWith("--format=")) {
      format = arg.slice("--format=".length);
      continue;
    }
    if (arg === "--fix-moved") {
      fixMoved = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--log-file") {
      i += 1;
      if (i >= argv.length) throw new Error("--log-file requires a value");
      logFile = argv[i];
      continue;
    }
    if (arg.startsWith("--log-file=")) {
      logFile = arg.slice("--log-file=".length);
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (root !== null) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
    root = arg;
  }

  const normalizedFormat = String(format || "").toLowerCase();
  if (normalizedFormat !== "markdown" && normalizedFormat !== "json") {
    throw new Error(`Unsupported format: ${format}`);
  }

  return {
    format: normalizedFormat,
    dryRun,
    fixMoved,
    logFile,
    root: path.resolve(process.cwd(), root || DEFAULT_ROOT),
  };
}

function toPortablePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, `'\\''`)}'`;
}

function isUnderRoot(root, targetPath) {
  const relative = path.relative(root, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isExternalTarget(rawTarget) {
  const text = String(rawTarget || "").trim();
  if (!text) return true;
  if (text.startsWith("data:")) return true;
  if (URL_SCHEME_RE.test(text)) return true;
  if (WINDOWS_ABS_RE.test(text)) return true;
  if (UNC_PATH_RE.test(text)) return true;
  if (text.startsWith("/") && !path.isAbsolute(text)) return false;
  return false;
}

function stripInlineCode(line) {
  return String(line || "").replace(/`[^`]*`/g, "");
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function unescapeMarkdownTarget(value) {
  return String(value || "").replace(ESCAPED_MARKDOWN_CHAR_RE, "$1");
}

function stripMarkdownTarget(rawTarget) {
  let text = String(rawTarget || "").trim();
  if (text.startsWith("[") && text.includes("](")) return "";
  if (text.startsWith("<") && text.includes(">")) {
    text = text.slice(1, text.indexOf(">"));
  }
  const titleMatch = text.match(/^(.*?)(?:\s+("[^"]*"|'[^']*'))\s*$/);
  if (titleMatch) text = titleMatch[1].trim();
  return unescapeMarkdownTarget(text);
}

function stripObsidianTarget(rawTarget) {
  let text = String(rawTarget || "").trim();
  text = text.split("|", 1)[0].trim();
  text = text.split("#", 1)[0].trim();
  text = text.split("^", 1)[0].trim();
  return unescapeMarkdownTarget(text);
}

function targetExtension(target) {
  return path.extname(String(target || "")).toLowerCase();
}

function isAttachmentLike(target, kind) {
  const text = String(target || "");
  if (!text) return false;
  if (kind === "md-image") return true;
  if (text.toLowerCase().includes(".assets/")) return true;
  return ATTACHMENT_EXTENSIONS.has(targetExtension(text));
}

function relativeAttachmentFolderPath(root, notePath, attachmentFolderPath) {
  if (!attachmentFolderPath) return null;
  if (attachmentFolderPath.startsWith("./")) {
    return path.resolve(path.dirname(notePath), attachmentFolderPath.slice(2));
  }
  return path.resolve(root, attachmentFolderPath);
}

async function readAttachmentFolderPath(root) {
  const configPath = path.join(root, ".obsidian", "app.json");
  if (!fs.existsSync(configPath)) return null;
  try {
    const text = await fsp.readFile(configPath, "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed.attachmentFolderPath !== "string") return null;
    return parsed.attachmentFolderPath.trim() || null;
  } catch {
    return null;
  }
}

async function walkVault(root) {
  const markdownFiles = [];
  const filePaths = [];
  const stack = [root];

  while (stack.length) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      filePaths.push(fullPath);
      if (entry.name.toLowerCase().endsWith(".md")) markdownFiles.push(fullPath);
    }
  }

  markdownFiles.sort();
  filePaths.sort();
  return { filePaths, markdownFiles };
}

function buildFileNameIndex(filePaths) {
  const byName = new Map();
  for (const filePath of filePaths) {
    const key = path.basename(filePath).toLowerCase();
    const values = byName.get(key) || [];
    values.push(filePath);
    byName.set(key, values);
  }
  return byName;
}

function isAttachmentFilePath(filePath) {
  const lower = filePath.toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  if (ATTACHMENT_EXTENSIONS.has(ext)) return true;
  return lower.includes(".assets/") || lower.includes("/index_files/") || lower.includes("/images/");
}

function buildSuffixIndex(root, filePaths) {
  const bySuffix = new Map();
  for (const filePath of filePaths) {
    if (!isAttachmentFilePath(filePath)) continue;
    const relPath = toPortablePath(path.relative(root, filePath));
    const parts = relPath.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i += 1) {
      const suffix = parts.slice(i).join("/");
      const values = bySuffix.get(suffix) || [];
      values.push(filePath);
      bySuffix.set(suffix, values);
    }
  }
  return bySuffix;
}

function normalizePathVariants(rawTarget, options = {}) {
  const values = [];
  const initial = options.obsidian ? stripObsidianTarget(rawTarget) : stripMarkdownTarget(rawTarget);
  const enqueue = (value) => {
    const text = String(value || "").trim();
    if (!text) return;
    if (!values.includes(text)) values.push(text);
  };

  enqueue(initial);
  enqueue(safeDecodeURIComponent(initial));

  for (const value of [...values]) {
    enqueue(value.replace(/\\/g, "/"));
  }

  if (!options.obsidian) {
    for (const value of [...values]) {
      const queryIndex = value.indexOf("?");
      if (queryIndex >= 0) enqueue(value.slice(0, queryIndex));
      const hashIndex = value.indexOf("#");
      if (hashIndex >= 0) enqueue(value.slice(0, hashIndex));
    }
  }

  return values;
}

function normalizeLookupKey(value) {
  return String(value || "")
    .trim()
    .replace(/^\.\//, "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

function resolveLocalTarget(root, notePath, rawTarget, kind, attachmentFolderPath, fileNameIndex, suffixIndex) {
  if (isExternalTarget(rawTarget)) return { status: "skipped" };

  const variants = normalizePathVariants(rawTarget, { obsidian: kind === "obsidian" });
  for (const variant of variants) {
    const normalizedVariant = normalizeLookupKey(variant);
    if (URL_SCHEME_RE.test(variant) || WINDOWS_ABS_RE.test(variant) || UNC_PATH_RE.test(variant)) {
      return { status: "skipped" };
    }

    if (path.isAbsolute(variant)) {
      if (fs.existsSync(variant) && isUnderRoot(root, variant)) return { status: "found", resolvedPath: variant };
      return { status: "skipped" };
    }

    const expectedPath = path.resolve(path.dirname(notePath), variant);
    const directCandidates = [
      expectedPath,
      path.resolve(root, variant),
    ];
    for (const candidate of directCandidates) {
      if (fs.existsSync(candidate) && isUnderRoot(root, candidate)) {
        return { status: "found", resolvedPath: candidate };
      }
    }

    const hasDirectory = variant.includes("/") || variant.includes("\\");
    const basename = path.basename(variant);
    if (basename && !hasDirectory) {
      const attachmentDir = relativeAttachmentFolderPath(root, notePath, attachmentFolderPath);
      if (attachmentDir) {
        const candidate = path.join(attachmentDir, basename);
        if (fs.existsSync(candidate) && isUnderRoot(root, candidate)) {
          return { status: "found", resolvedPath: candidate };
        }
      }

      const matches = fileNameIndex.get(basename.toLowerCase()) || [];
      if (matches.length > 0) {
        return { status: "found", resolvedPath: matches[0] };
      }
    }

    if (normalizedVariant.includes("/")) {
      const movedMatches = suffixIndex.get(normalizedVariant) || [];
      if (movedMatches.length > 0) {
        return {
          status: "moved",
          expectedPath,
          matchedSuffix: normalizedVariant,
          resolvedPath: movedMatches[0],
          candidateCount: movedMatches.length,
        };
      }
    }
  }

  return { status: "missing" };
}

function extractReferencesFromLine(line) {
  const refs = [];
  const content = stripInlineCode(line);

  for (const match of content.matchAll(OBSIDIAN_EMBED_RE)) {
    refs.push({ kind: "obsidian", rawTarget: match[1] });
  }
  for (const match of content.matchAll(OBSIDIAN_LINK_RE)) {
    refs.push({ kind: "obsidian", rawTarget: match[1] });
  }
  for (const match of content.matchAll(MARKDOWN_IMAGE_RE)) {
    refs.push({ kind: "md-image", rawTarget: match[1] });
  }
  for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
    refs.push({ kind: "md-link", rawTarget: match[1] });
  }

  return refs;
}

async function scanVault(root) {
  const { filePaths, markdownFiles } = await walkVault(root);
  const fileNameIndex = buildFileNameIndex(filePaths);
  const suffixIndex = buildSuffixIndex(root, filePaths);
  const attachmentFolderPath = await readAttachmentFolderPath(root);
  const missing = [];
  const moved = [];
  const missingNoteSet = new Set();
  const movedNoteSet = new Set();
  let referencesChecked = 0;

  for (const notePath of markdownFiles) {
    let text;
    try {
      text = await fsp.readFile(notePath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    const lines = text.split("\n");
    let insideFence = false;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (FENCE_RE.test(line)) {
        insideFence = !insideFence;
        continue;
      }
      if (insideFence) continue;

      const refs = extractReferencesFromLine(line);
      for (const ref of refs) {
        const cleanedTarget = ref.kind === "obsidian" ? stripObsidianTarget(ref.rawTarget) : stripMarkdownTarget(ref.rawTarget);
        if (!isAttachmentLike(cleanedTarget, ref.kind)) continue;

        referencesChecked += 1;
        const resolved = resolveLocalTarget(
          root,
          notePath,
          ref.rawTarget,
          ref.kind,
          attachmentFolderPath,
          fileNameIndex,
          suffixIndex,
        );
        if (resolved.status === "missing") {
          const relativeNotePath = toPortablePath(path.relative(root, notePath));
          missingNoteSet.add(relativeNotePath);
          missing.push({
            kind: ref.kind,
            line: index + 1,
            notePath: relativeNotePath,
            target: cleanedTarget,
          });
          continue;
        }
        if (resolved.status === "moved") {
          const relativeNotePath = toPortablePath(path.relative(root, notePath));
          movedNoteSet.add(relativeNotePath);
          moved.push({
            kind: ref.kind,
            line: index + 1,
            notePath: relativeNotePath,
            target: cleanedTarget,
            expectedPath: toPortablePath(path.relative(root, resolved.expectedPath)),
            matchedSuffix: resolved.matchedSuffix,
            resolvedPath: toPortablePath(path.relative(root, resolved.resolvedPath)),
            candidateCount: resolved.candidateCount,
          });
        }
      }
    }
  }

  missing.sort((a, b) => {
    if (a.notePath !== b.notePath) return a.notePath.localeCompare(b.notePath, "zh-Hans-CN");
    if (a.line !== b.line) return a.line - b.line;
    return a.target.localeCompare(b.target, "zh-Hans-CN");
  });

  moved.sort((a, b) => {
    if (a.notePath !== b.notePath) return a.notePath.localeCompare(b.notePath, "zh-Hans-CN");
    if (a.line !== b.line) return a.line - b.line;
    return a.target.localeCompare(b.target, "zh-Hans-CN");
  });

  return {
    root,
    attachmentFolderPath,
    stats: {
      markdownFiles: markdownFiles.length,
      missingReferences: missing.length,
      movedReferences: moved.length,
      notesWithMissingReferences: missingNoteSet.size,
      notesWithMovedReferences: movedNoteSet.size,
      referencesChecked,
    },
    moved,
    missing,
  };
}

function buildMoveOperations(root, movedItems) {
  const ops = new Map();

  for (const item of movedItems) {
    const suffixParts = String(item.matchedSuffix || "").split("/").filter(Boolean);
    const expectedParts = String(item.expectedPath || "").split("/").filter(Boolean);
    const resolvedParts = String(item.resolvedPath || "").split("/").filter(Boolean);
    if (suffixParts.length === 0) continue;
    if (expectedParts.length < suffixParts.length) continue;
    if (resolvedParts.length < suffixParts.length) continue;

    const sourceRootRel = resolvedParts.slice(0, resolvedParts.length - suffixParts.length + 1).join("/");
    const destinationRootRel = expectedParts.slice(0, expectedParts.length - suffixParts.length + 1).join("/");
    const key = `${sourceRootRel} -> ${destinationRootRel}`;
    const op = ops.get(key) || {
      destinationRootRel,
      sourceRootRel,
      items: [],
      ambiguous: false,
    };
    op.items.push(item);
    if (item.candidateCount > 1) op.ambiguous = true;
    ops.set(key, op);
  }

  return [...ops.values()].sort((a, b) => a.destinationRootRel.localeCompare(b.destinationRootRel, "zh-Hans-CN"));
}

async function appendLog(logFile, lines) {
  await fsp.mkdir(path.dirname(logFile), { recursive: true });
  await fsp.appendFile(logFile, `${lines.join("\n")}\n`, "utf8");
}

async function fixMovedReferences(root, movedItems, options) {
  const logFile = path.resolve(options.logFile || path.join(root, DEFAULT_LOG_FILE));
  const operations = buildMoveOperations(root, movedItems);
  const timestamp = new Date().toISOString();
  const logLines = [
    `=== ${timestamp} find-missing-local-resources ${options.dryRun ? "dry-run" : "fix"} ===`,
    `root: ${root}`,
    `moved references: ${movedItems.length}`,
    `move operations: ${operations.length}`,
    `log file: ${logFile}`,
  ];

  const summary = {
    dryRun: options.dryRun,
    enabled: true,
    logFile,
    operationsPlanned: operations.length,
    operationsApplied: 0,
    operationsFailed: 0,
    operationsSkipped: 0,
    details: [],
  };

  if (operations.length === 0) {
    logLines.push("no moved resource directories detected");
    await appendLog(logFile, [...logLines, ""]);
    return summary;
  }

  for (const op of operations) {
    const sourceAbs = path.join(root, op.sourceRootRel);
    const destinationAbs = path.join(root, op.destinationRootRel);
    const command = `mv ${shellQuote(sourceAbs)} ${shellQuote(destinationAbs)}`;
    const detail = {
      command,
      destinationRootRel: op.destinationRootRel,
      sourceRootRel: op.sourceRootRel,
      itemCount: op.items.length,
      status: "planned",
    };

    logLines.push(`command: ${command}`);
    logLines.push(`source: ${op.sourceRootRel}`);
    logLines.push(`destination: ${op.destinationRootRel}`);
    logLines.push(`references: ${op.items.length}`);

    if (op.ambiguous) {
      detail.status = "skipped";
      detail.reason = "ambiguous-moved-match";
      summary.operationsSkipped += 1;
      summary.details.push(detail);
      logLines.push("result: skipped (ambiguous moved match)");
      continue;
    }
    if (sourceAbs === destinationAbs) {
      detail.status = "skipped";
      detail.reason = "already-in-place";
      summary.operationsSkipped += 1;
      summary.details.push(detail);
      logLines.push("result: skipped (already in place)");
      continue;
    }
    if (!fs.existsSync(sourceAbs)) {
      detail.status = "skipped";
      detail.reason = "source-missing";
      summary.operationsSkipped += 1;
      summary.details.push(detail);
      logLines.push("result: skipped (source missing)");
      continue;
    }
    if (fs.existsSync(destinationAbs)) {
      detail.status = "skipped";
      detail.reason = "destination-exists";
      summary.operationsSkipped += 1;
      summary.details.push(detail);
      logLines.push("result: skipped (destination exists)");
      continue;
    }
    if (options.dryRun) {
      detail.status = "dry-run";
      summary.details.push(detail);
      logLines.push("result: dry-run (not executed)");
      continue;
    }

    await fsp.mkdir(path.dirname(destinationAbs), { recursive: true });
    try {
      await execFileAsync("mv", [sourceAbs, destinationAbs]);
      detail.status = "applied";
      summary.operationsApplied += 1;
      summary.details.push(detail);
      logLines.push("result: applied");
    } catch (error) {
      detail.status = "failed";
      detail.reason = error && error.message ? error.message : String(error);
      summary.operationsFailed += 1;
      summary.details.push(detail);
      logLines.push(`result: failed (${detail.reason})`);
    }
  }

  await appendLog(logFile, [...logLines, ""]);
  return summary;
}

function formatMarkdown(report) {
  const lines = [];
  lines.push("# Local Resource Report");
  lines.push("");
  lines.push(`- Root: \`${report.root}\``);
  lines.push(`- Markdown files scanned: ${report.stats.markdownFiles}`);
  lines.push(`- Local attachment references checked: ${report.stats.referencesChecked}`);
  lines.push(`- Missing references: ${report.stats.missingReferences}`);
  lines.push(`- Moved references: ${report.stats.movedReferences}`);
  lines.push(`- Notes with missing references: ${report.stats.notesWithMissingReferences}`);
  lines.push(`- Notes with moved references: ${report.stats.notesWithMovedReferences}`);
  if (report.attachmentFolderPath) {
    lines.push(`- Obsidian attachment folder: \`${report.attachmentFolderPath}\``);
  }
  if (report.fix) {
    lines.push(`- Fix moved: ${report.fix.dryRun ? "dry-run" : "enabled"}`);
    lines.push(`- Fix log: \`${report.fix.logFile}\``);
  }
  lines.push("");
  if (report.fix) {
    lines.push("## Fix Moved");
    lines.push("");
    lines.push(`- Operations planned: ${report.fix.operationsPlanned}`);
    lines.push(`- Operations applied: ${report.fix.operationsApplied}`);
    lines.push(`- Operations skipped: ${report.fix.operationsSkipped}`);
    lines.push(`- Operations failed: ${report.fix.operationsFailed}`);
    lines.push("");
  }
  lines.push("## Moved References");
  lines.push("");

  if (report.moved.length === 0) {
    lines.push("None.");
  } else {
    let currentNotePath = null;
    for (const item of report.moved) {
      if (item.notePath !== currentNotePath) {
        if (currentNotePath !== null) lines.push("");
        currentNotePath = item.notePath;
        lines.push(`### \`${item.notePath}\``);
      }
      const extra = item.candidateCount > 1 ? ` (+${item.candidateCount - 1} more)` : "";
      lines.push(`- line ${item.line}: \`${item.target}\` -> \`${item.resolvedPath}\`${extra} (${item.kind})`);
    }
  }

  lines.push("");
  lines.push("## Missing References");
  lines.push("");

  if (report.missing.length === 0) {
    lines.push("None.");
    return lines.join("\n");
  }

  let currentNotePath = null;
  for (const item of report.missing) {
    if (item.notePath !== currentNotePath) {
      if (currentNotePath !== null) lines.push("");
      currentNotePath = item.notePath;
      lines.push(`### \`${item.notePath}\``);
    }
    lines.push(`- line ${item.line}: \`${item.target}\` (${item.kind})`);
  }

  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(args.root) || !fs.statSync(args.root).isDirectory()) {
    throw new Error(`Root directory not found: ${args.root}`);
  }

  const initialReport = await scanVault(args.root);
  let report = initialReport;
  if (args.fixMoved) {
    const fix = await fixMovedReferences(args.root, initialReport.moved, {
      dryRun: args.dryRun,
      logFile: args.logFile,
    });
    if (!args.dryRun && fix.operationsApplied > 0) {
      report = await scanVault(args.root);
    }
    report.fix = fix;
  }

  if (args.format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatMarkdown(report));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
