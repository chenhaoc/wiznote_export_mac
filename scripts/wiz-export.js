#!/usr/bin/env node
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const http = require("http");
const net = require("net");
const { spawn, execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const DEFAULT_PROFILE = path.join(os.homedir(), "Library/Application Support/WizNote");
const DEFAULT_LIVE_EDITOR =
  "/Applications/为知笔记.app/Contents/Resources/assets/wizres/live-editor/index.js";
const DEFAULT_OUT = path.resolve(process.cwd(), "export");

const COMMANDS = new Set(["status", "export", "help"]);

function usage() {
  return `Usage:
  node scripts/wiz-export.js status [--json] [--profile PATH]
  node scripts/wiz-export.js export --out DIR [--wait] [--allow-partial] [--fetch-missing] [--coedit-only] [--limit N] [--only DOC_GUID]

Options:
  --out DIR          Export output directory. Default: ./export
  --profile PATH     WizNote profile path. Default: ~/Library/Application Support/WizNote
  --allow-partial    Export notes with local bodies and skip missing ones
  --fetch-missing    Fetch/sync missing note bodies from WizNote server during export
  --coedit-only      Export only collaboration notes and skip legacy HTML notes
  --simple-html      Use a faster, lower-fidelity converter for standard HTML notes
  --wait             Poll until local note bodies look complete
  --poll-ms N        Poll interval for --wait. Default: 60000
  --note-timeout-ms N
                     Timeout for one note conversion. Default: 90000
  --limit N          Export at most N notes
  --only DOC_GUID    Export one note by docGuid
  --json             Print JSON
  --keep-temp        Keep temporary Chrome profile for debugging
`;
}

function parseArgs(argv) {
  const command = argv[2] && COMMANDS.has(argv[2]) ? argv[2] : "help";
  const args = {
    command,
    out: DEFAULT_OUT,
    profile: DEFAULT_PROFILE,
    liveEditor: DEFAULT_LIVE_EDITOR,
    allowPartial: false,
    fetchMissing: false,
    coeditOnly: false,
    simpleHtml: false,
    wait: false,
    pollMs: 60000,
    noteTimeoutMs: 90000,
    json: false,
    keepTemp: false,
    limit: null,
    only: null,
  };

  for (let i = 3; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") args.out = path.resolve(argv[++i]);
    else if (a === "--profile") args.profile = path.resolve(argv[++i]);
    else if (a === "--live-editor") args.liveEditor = path.resolve(argv[++i]);
    else if (a === "--allow-partial") args.allowPartial = true;
    else if (a === "--fetch-missing") args.fetchMissing = true;
    else if (a === "--coedit-only") args.coeditOnly = true;
    else if (a === "--simple-html") args.simpleHtml = true;
    else if (a === "--wait") args.wait = true;
    else if (a === "--json") args.json = true;
    else if (a === "--keep-temp") args.keepTemp = true;
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--only") args.only = argv[++i];
    else if (a === "--poll-ms") args.pollMs = Number(argv[++i]);
    else if (a === "--note-timeout-ms") args.noteTimeoutMs = Number(argv[++i]);
    else if (a === "--help" || a === "-h") args.command = "help";
    else throw new Error(`Unknown option: ${a}`);
  }

  if (args.limit != null && (!Number.isFinite(args.limit) || args.limit < 1)) {
    throw new Error("--limit must be a positive number");
  }
  if (!Number.isFinite(args.pollMs) || args.pollMs < 1000) {
    throw new Error("--poll-ms must be at least 1000");
  }
  if (!Number.isFinite(args.noteTimeoutMs) || args.noteTimeoutMs < 5000) {
    throw new Error("--note-timeout-ms must be at least 5000");
  }
  return args;
}

function log(args, message) {
  if (!args.json) console.log(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateProcess(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGTERM");
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  throw new Error("Chrome/Chromium not found. Set CHROME_PATH to a Chromium-based browser binary.");
}

async function copyProfile(sourceProfile, targetProfile, options = {}) {
  await fsp.mkdir(targetProfile, { recursive: true });
  const source = sourceProfile.endsWith(path.sep) ? sourceProfile : `${sourceProfile}${path.sep}`;
  const target = targetProfile.endsWith(path.sep) ? targetProfile : `${targetProfile}${path.sep}`;
  const args = [
    "-a",
    "--delete",
    "--exclude=Singleton*",
    "--exclude=Crashpad",
    "--exclude=Cache",
    "--exclude=Code Cache",
    "--exclude=GPUCache",
    "--exclude=blob_storage",
  ];
  if (!options.includeResourceCache) args.push("--exclude=Service Worker/CacheStorage");
  args.push(source, target);
  await execFileAsync("/usr/bin/rsync", args, { maxBuffer: 1024 * 1024 * 32 });
}

async function detectWizNotePort() {
  try {
    const { stdout } = await execFileAsync(
      "/usr/sbin/lsof",
      ["-nP", "-a", "-c", "WizNote", "-iTCP", "-sTCP:LISTEN"],
      { maxBuffer: 1024 * 1024 }
    );
    const ports = [];
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/(?:127\.0\.0\.1|localhost):(\d+)\s+\(LISTEN\)/);
      if (match) ports.push(Number(match[1]));
    }
    return ports[0] || null;
  } catch {
    return null;
  }
}

async function startOriginServer({ liveEditorPath, appPort }) {
  const liveEditor = await fsp.readFile(liveEditorPath);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://wiznote-desktop");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><meta charset=\"utf-8\"><title>wiz-export</title>");
      return;
    }
    if (url.pathname === "/live-editor/index.js") {
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(liveEditor);
      return;
    }
    if (url.pathname === "/__wiz_export_proxy") {
      const target = url.searchParams.get("url");
      if (!target || !/^https:\/\/[^/]+\.wiz\.cn\//i.test(target)) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("invalid proxy target");
        return;
      }
      const headers = {};
      if (req.headers["x-wiz-token"]) headers["x-wiz-token"] = req.headers["x-wiz-token"];
      if (req.headers["x-live-editor-token"]) headers["x-live-editor-token"] = req.headers["x-live-editor-token"];
      if (req.headers["x-live-editor-base-url"]) headers["x-live-editor-base-url"] = req.headers["x-live-editor-base-url"];
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        fetch(target, { method: req.method, headers, body, signal: controller.signal })
        .then(async (proxyRes) => {
          clearTimeout(timer);
          const buffer = Buffer.from(await proxyRes.arrayBuffer());
          res.writeHead(proxyRes.status, {
            "content-type": proxyRes.headers.get("content-type") || "application/octet-stream",
            "cache-control": "no-store",
          });
          res.end(buffer);
        })
        .catch((err) => {
          clearTimeout(timer);
          res.writeHead(err.name === "AbortError" ? 504 : 502, { "content-type": "text/plain; charset=utf-8" });
          res.end(`Remote proxy failed: ${err.message}`);
        });
      });
      return;
    }
    if (appPort && url.pathname.startsWith("/ks/")) {
      const proxy = http.request(
        {
          hostname: "127.0.0.1",
          port: appPort,
          method: req.method,
          path: req.url,
          headers: {
            ...req.headers,
            host: "wiznote-desktop",
          },
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.pipe(res);
        }
      );
      proxy.on("error", (err) => {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`Proxy to WizNote failed: ${err.message}`);
      });
      req.pipe(proxy);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  return { server, port };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new CdpClient(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(detail);
    }
    return result.result.value;
  }

  close() {
    this.ws.close();
  }
}

async function waitForPageWebSocket(debugPort) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < 20000) {
    try {
      const pages = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
      const page = pages.find((p) => p.type === "page" && p.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for Chrome DevTools page${lastError ? `: ${lastError.message}` : ""}`);
}

async function withBrowser(args, fn, options = {}) {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "wiz-export-"));
  const chromeUserData = path.join(tmpRoot, "chrome-user-data");
  const chromeProfile = path.join(chromeUserData, "Default");
  const appPort = await detectWizNotePort();
  const originServer = await startOriginServer({ liveEditorPath: args.liveEditor, appPort });
  const debugPort = await getFreePort();
  let chrome = null;
  let cdp = null;

  try {
    await copyProfile(args.profile, chromeProfile, {
      includeResourceCache: !!options.includeResourceCache,
    });
    const chromePath = await findChrome();
    chrome = spawn(
      chromePath,
      [
        `--user-data-dir=${chromeUserData}`,
        "--profile-directory=Default",
        `--remote-debugging-port=${debugPort}`,
        `--host-rules=MAP wiznote-desktop 127.0.0.1:${originServer.port}`,
        "--unsafely-treat-insecure-origin-as-secure=http://wiznote-desktop",
        "--proxy-server=direct://",
        "--proxy-bypass-list=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-extensions",
        "--disable-sync",
        "--disable-gpu",
        "--disable-web-security",
        "--headless=new",
        "http://wiznote-desktop/",
      ],
      { stdio: "ignore" }
    );

    const wsUrl = await waitForPageWebSocket(debugPort);
    cdp = await CdpClient.connect(wsUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: "http://wiznote-desktop/" });
    await sleep(1000);
    await installPageHelpers(cdp);
    return await fn(cdp, { tmpRoot, appPort });
  } finally {
    if (cdp) cdp.close();
    await terminateProcess(chrome);
    await new Promise((resolve) => originServer.server.close(resolve));
    if (!args.keepTemp) {
      try {
        await fsp.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (err) {
        console.error(`Warning: failed to remove temporary profile ${tmpRoot}: ${err.message}`);
      }
    } else {
      console.error(`Temporary Chrome profile kept at: ${tmpRoot}`);
    }
  }
}

async function installPageHelpers(cdp) {
  await cdp.evaluate(`(async () => {
${browserHelperSource()}
  return window.__WIZ_EXPORT__.health();
})()`);
}

function browserHelperSource() {
  return String.raw`
if (!window.__WIZ_EXPORT__) {
  const helper = {};
  const state = {
    userDbName: null,
    liveEditorReady: false,
    resourceAuth: {},
  };

  function requestToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function openDb(name) {
    return requestToPromise(indexedDB.open(name));
  }

  async function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
    });
  }

  function byteLength(value) {
    if (value == null) return 0;
    if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (value instanceof Blob) return value.size;
    if (value && value.buffer instanceof ArrayBuffer) return value.byteLength || value.buffer.byteLength;
    return 0;
  }

  async function valueToArrayBuffer(value) {
    if (value == null) return null;
    if (typeof value === "string") return new TextEncoder().encode(value).buffer;
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    if (value instanceof Blob) return value.arrayBuffer();
    if (value && value.buffer instanceof ArrayBuffer) return value.buffer;
    return null;
  }

  async function valueToText(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    const buffer = await valueToArrayBuffer(value);
    if (!buffer) return "";
    return new TextDecoder("utf-8").decode(buffer);
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
    try {
      return await fetch(url, { ...(options || {}), signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function withTimeout(promise, timeoutMs, label) {
    let timer = null;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label + " timed out after " + timeoutMs + "ms")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function valueToBase64(value) {
    const buffer = await valueToArrayBuffer(value);
    return buffer ? arrayBufferToBase64(buffer) : null;
  }

  function cloneWithoutData(value) {
    if (!value || typeof value !== "object") return value;
    const out = { ...value };
    if ("data" in out) {
      out.hasData = out.data != null && byteLength(out.data) > 0;
      out.dataBytes = byteLength(out.data);
      delete out.data;
    }
    return jsonSafe(out);
  }

  function jsonSafe(value) {
    if (value == null) return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      if (Array.isArray(value)) return value.map(jsonSafe);
      if (typeof value === "object") {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
          if (typeof item === "function") continue;
          if (item instanceof ArrayBuffer || ArrayBuffer.isView(item) || item instanceof Blob) {
            out[key] = { dataBytes: byteLength(item), hasData: byteLength(item) > 0 };
          } else {
            out[key] = jsonSafe(item);
          }
        }
        return out;
      }
      return value;
    }
  }

  function pickFields(value, keys) {
    const out = {};
    const source = value || {};
    for (const key of keys) {
      if (source[key] !== undefined) out[key] = source[key];
    }
    return jsonSafe(out);
  }

  function trimRows(rows, keys) {
    return rows.map((row) => ({
      key: row.key,
      value: pickFields(row.value, keys),
    }));
  }

  async function readStoreEntries(dbName, storeName, options = {}) {
    const db = await openDb(dbName);
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const out = [];
    await new Promise((resolve, reject) => {
      const req = store.openCursor();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        out.push({
          key: jsonSafe(cursor.key),
          value: options.omitData ? cloneWithoutData(cursor.value) : jsonSafe(cursor.value),
        });
        cursor.continue();
      };
    });
    db.close();
    return out;
  }

  async function countStore(dbName, storeName) {
    const db = await openDb(dbName);
    const tx = db.transaction(storeName, "readonly");
    const count = await requestToPromise(tx.objectStore(storeName).count());
    db.close();
    return count;
  }

  async function getValue(dbName, storeName, key) {
    const db = await openDb(dbName);
    const tx = db.transaction(storeName, "readonly");
    const value = await requestToPromise(tx.objectStore(storeName).get(key));
    db.close();
    return value;
  }

  async function getDbInfo() {
    const dbs = await indexedDB.databases();
    const infos = [];
    for (const item of dbs) {
      if (!item.name) continue;
      const db = await openDb(item.name);
      const stores = Array.from(db.objectStoreNames);
      db.close();
      infos.push({ name: item.name, version: item.version, stores });
    }
    return infos;
  }

  async function ensureUserDbName() {
    if (state.userDbName) return state.userDbName;
    const infos = await getDbInfo();
    const userDb = infos.find((db) =>
      /^wiz-[0-9a-f-]+$/i.test(db.name) &&
      db.stores.includes("docs") &&
      db.stores.includes("folders") &&
      db.stores.includes("data")
    );
    if (!userDb) throw new Error("WizNote user IndexedDB not found");
    state.userDbName = userDb.name;
    return state.userDbName;
  }

  async function getAccountToken() {
    try {
      const infos = await getDbInfo();
      const accountDb = infos.find((db) => db.name === "wiz-account" && db.stores.includes("accounts"));
      if (!accountDb) return "";
      const rows = await readStoreEntries("wiz-account", "accounts", { omitData: true });
      const account = rows.map((row) => row.value).find((item) => item && (item.current === 1 || item.current === true)) ||
        (rows[0] && rows[0].value);
      return account && account.token ? account.token : "";
    } catch {
      return "";
    }
  }

  function urlSafeBase64(value) {
    return btoa(unescape(encodeURIComponent(value)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  async function getCoEditResourceAuth(note, kb) {
    const key = note.kbGuid + ":" + note.docGuid;
    if (state.resourceAuth[key]) return state.resourceAuth[key];
    if (!kb || !kb.kbServer) return null;
    const accountToken = await getAccountToken();
    if (!accountToken) return null;
    const headers = { "x-wiz-token": accountToken };
    const tokenUrl = kb.kbServer + "/ks/note/" + note.kbGuid + "/" + note.docGuid + "/tokens";
    const tokenResp = await fetchWithTimeout("/__wiz_export_proxy?url=" + encodeURIComponent(tokenUrl), {
      method: "POST",
      headers,
    }, 10000).catch(() => null);
    if (!tokenResp || !tokenResp.ok) return null;
    const tokenJson = await tokenResp.json().catch(() => null);
    const editorToken = tokenJson && (tokenJson.editorToken || (tokenJson.result && tokenJson.result.editorToken));
    if (!editorToken) return null;
    const apiServer = kb.kbServer + "/editor/" + note.kbGuid + "/" + note.docGuid;
    const authResp = await fetchWithTimeout("/__wiz_export_proxy?url=" + encodeURIComponent(apiServer + "/auth"), {
      method: "GET",
      headers: {
        "x-live-editor-token": editorToken,
        "x-live-editor-base-url": urlSafeBase64(apiServer),
      },
    }, 10000).catch(() => null);
    if (!authResp || !authResp.ok) return null;
    const authJson = await authResp.json().catch(() => null);
    const readToken = authJson && (authJson.read || authJson.token || (authJson.result && authJson.result.read));
    if (!readToken) return null;
    state.resourceAuth[key] = { apiServer, token: readToken };
    return state.resourceAuth[key];
  }

  async function getCoEditEditorAuth(note, kb) {
    if (!kb || !kb.kbServer) return null;
    const accountToken = await getAccountToken();
    if (!accountToken) return null;
    const tokenUrl = kb.kbServer + "/ks/note/" + note.kbGuid + "/" + note.docGuid + "/tokens";
    const tokenResp = await fetchWithTimeout("/__wiz_export_proxy?url=" + encodeURIComponent(tokenUrl), {
      method: "POST",
      headers: { "x-wiz-token": accountToken },
    }, 10000).catch(() => null);
    if (!tokenResp || !tokenResp.ok) return null;
    const tokenJson = await tokenResp.json().catch(() => null);
    const editorToken = tokenJson && (tokenJson.editorToken || (tokenJson.result && tokenJson.result.editorToken));
    return editorToken ? { token: editorToken } : null;
  }

  function keyParts(key) {
    return Array.isArray(key) ? key : [key];
  }

  function isCoEdit(type) {
    return String(type || "").toLowerCase().startsWith("collaboration");
  }

  function isExternalResource(src) {
    const s = String(src || "").trim();
    return /^(https?:|file:|data:|blob:|about:|mailto:|wiz:|wiznote:)/i.test(s);
  }

  function sanitizeFileName(name, fallback = "untitled") {
    let out = String(name || fallback)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "");
    if (!out) out = fallback;
    if (out.length > 180) {
      const extMatch = out.match(/(\.[^.]*)$/);
      const ext = extMatch ? extMatch[1] : "";
      out = out.slice(0, 180 - ext.length).trim() + ext;
    }
    return out;
  }

  function basenameFromUrl(src) {
    const clean = String(src || "").split("#")[0].split("?")[0];
    const parts = clean.split("/");
    return parts[parts.length - 1] || clean;
  }

  function normalizeResourceName(src) {
    let value = String(Array.isArray(src) ? src[0] : src || "").trim();
    try {
      value = decodeURIComponent(value);
    } catch {}
    const indexFiles = value.match(/(?:^|\/)index_files\/(.+)$/);
    if (indexFiles) return indexFiles[1];
    return basenameFromUrl(value);
  }

  function markdownUrl(filePath) {
    return encodeURI(filePath).replace(/[()]/g, (c) => c === "(" ? "%28" : "%29");
  }

  async function installLiveEditor() {
    if (window.LiveEditor) {
      state.liveEditorReady = true;
      return true;
    }
    const response = await fetch("/live-editor/index.js", { cache: "no-store" });
    if (!response.ok) throw new Error("failed to fetch LiveEditor: http-" + response.status);
    const code = await response.text();
    (0, eval)(code + "\n//# sourceURL=wiz-live-editor.js");
    state.liveEditorReady = !!window.LiveEditor;
    if (!state.liveEditorReady) throw new Error("LiveEditor loaded but window.LiveEditor is missing");
    return state.liveEditorReady;
  }

  async function readDataIndex(userDbName) {
    const rows = await readStoreEntries(userDbName, "data", { omitData: true });
    return rows.map((row) => {
      const [kbGuid, docGuid, dataId] = keyParts(row.key);
      return {
        key: row.key,
        kbGuid,
        docGuid,
        dataId,
        dataType: row.value && row.value.dataType,
        status: row.value && row.value.status,
        hasData: !!(row.value && row.value.hasData),
        dataBytes: (row.value && row.value.dataBytes) || 0,
      };
    });
  }

  async function readEditorDocKeys() {
    const infos = await getDbInfo();
    const dbInfo = infos.find((db) => db.name === "wiz-editor-ot" && db.stores.includes("docs"));
    if (!dbInfo) return [];
    const rows = await readStoreEntries("wiz-editor-ot", "docs", { omitData: true });
    return rows.map((row) => row.key);
  }

  async function readEditorResourceIndex() {
    const infos = await getDbInfo();
    const dbInfo = infos.find((db) => db.name === "wiz-editor-ot-res" && db.stores.includes("cache"));
    if (!dbInfo) return [];
    const rows = await readStoreEntries("wiz-editor-ot-res", "cache", { omitData: true });
    return rows.map((row) => ({ key: row.key, value: row.value }));
  }

  async function readCacheResourceIndex() {
    if (!window.caches) return [];
    try {
      const cache = await caches.open("wiz-note-resource");
      const requests = await cache.keys();
      return requests.map((request) => request.url);
    } catch {
      return [];
    }
  }

  async function readSnapshot() {
    const dbs = await getDbInfo();
    const userDbName = await ensureUserDbName();
    const counts = {};
    for (const store of ["docs", "folders", "kbs", "settings2", "attachments", "data", "tags"]) {
      counts[store] = await countStore(userDbName, store).catch(() => null);
    }
    const docs = trimRows(await readStoreEntries(userDbName, "docs", { omitData: true }), [
      "docGuid",
      "kbGuid",
      "title",
      "category",
      "type",
      "status",
      "tags",
      "created",
      "dataModified",
      "infoModified",
    ]);
    const folders = trimRows(await readStoreEntries(userDbName, "folders", { omitData: true }), [
      "kbGuid",
      "key",
      "location",
      "name",
    ]);
    const kbs = trimRows(await readStoreEntries(userDbName, "kbs", { omitData: true }), [
      "kbGuid",
      "name",
      "kbName",
      "noteCount",
      "dataProgress",
      "kbServer",
    ]);
    const settings2 = await readStoreEntries(userDbName, "settings2", { omitData: true });
    const attachments = trimRows(await readStoreEntries(userDbName, "attachments", { omitData: true }), [
      "attGuid",
      "kbGuid",
      "docGuid",
      "name",
      "dataSize",
      "status",
    ]);
    const dataIndex = await readDataIndex(userDbName);
    const editorDocKeys = await readEditorDocKeys();
    const editorResources = [];
    const cacheResources = [];
    return { dbs, userDbName, counts, docs, folders, kbs, settings2, attachments, dataIndex, editorDocKeys, editorResources, cacheResources };
  }

  async function getDataRecord(kbGuid, docGuid, dataId) {
    const userDbName = await ensureUserDbName();
    return getValue(userDbName, "data", [kbGuid, docGuid, dataId]);
  }

  async function getHtmlData(note) {
    const local = await getDataRecord(note.kbGuid, note.docGuid, "index.html");
    if (local && local.data != null && byteLength(local.data) > 0) {
      return { html: await valueToText(local.data), source: "indexeddb" };
    }
    return { html: "", source: "missing" };
  }

  async function fetchRemoteDocData(note, kb) {
    if (!kb || !kb.kbServer) return { html: "", source: "remote-missing-kb-server" };
    const token = await getAccountToken();
    if (!token) return { html: "", source: "remote-missing-account-token" };
    const url = kb.kbServer + "/ks/note/download/" + note.kbGuid + "/" + note.docGuid + "?downloadInfo=1&downloadData=1";
    try {
      const response = await fetchWithTimeout("/__wiz_export_proxy?url=" + encodeURIComponent(url), {
        headers: { "x-wiz-token": token },
      }, 15000);
      if (!response.ok) return { html: "", source: "remote-http-" + response.status };
      const json = await response.json().catch(() => null);
      if (!json) return { html: "", source: "remote-invalid-json" };
      if (json.returnCode && json.returnCode !== 200) {
        return { html: "", source: "remote-code-" + json.returnCode + ":" + (json.returnMessage || "") };
      }
      if (json.html) return { html: json.html, source: "wiznote-server", resources: json.resources || [] };
      if (json.result && json.result.html) {
        return { html: json.result.html, source: "wiznote-server", resources: json.result.resources || [] };
      }
      return { html: "", source: json.url ? "remote-ziw-document" : "remote-no-html" };
    } catch (err) {
      return { html: "", source: "remote-error:" + err.message };
    }
  }

  function htmlAttr(tag, name) {
    const source = String(tag || "");
    let match = source.match(new RegExp(name + "\\s*=\\s*\\\"([^\\\"]*)\\\"", "i"));
    if (match) return match[1] || "";
    match = source.match(new RegExp(name + "\\s*=\\s*'([^']*)'", "i"));
    if (match) return match[1] || "";
    match = source.match(new RegExp(name + "\\s*=\\s*([^\\s>]+)", "i"));
    return match ? (match[1] || "") : "";
  }

  function decodeHtmlEntities(value) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = String(value || "");
    return textarea.value;
  }

  function stripHtmlText(value) {
    return decodeHtmlEntities(String(value || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t\r\f\v]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .trim());
  }

  function roughHtmlToMarkdown(html, assetDirName, reserveResource) {
    let text = String(html || "");
    const body = text.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    if (body) text = body[1];
    text = text
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "");
    text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code) => {
      const fence = String.fromCharCode(96).repeat(3);
      return "\n\n" + fence + "\n" + stripHtmlText(code).replace(/\n+$/g, "") + "\n" + fence + "\n\n";
    });
    text = text.replace(/<img\b[^>]*>/gi, (tag) => {
      const src = htmlAttr(tag, "src");
      const alt = stripHtmlText(htmlAttr(tag, "alt"));
      if (!src) return "";
      if (isExternalResource(src)) return "![" + alt + "](" + src + ")";
      const ref = reserveResource(src);
      return "![" + alt + "](" + markdownUrl(assetDirName + "/" + ref.fileName) + ")";
    });
    text = text.replace(/<a\b[^>]*href\s*=\s*(\"([^\"]*)\"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (_m, _hrefRaw, h1, h2, h3, label) => {
      const href = h1 || h2 || h3 || "";
      const cleanLabel = stripHtmlText(label) || href;
      return href ? "[" + cleanLabel + "](" + href + ")" : cleanLabel;
    });
    text = text
      .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_m, value) => "\n\n# " + stripHtmlText(value) + "\n\n")
      .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_m, value) => "\n\n## " + stripHtmlText(value) + "\n\n")
      .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (_m, value) => "\n\n### " + stripHtmlText(value) + "\n\n")
      .replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, (_m, value) => "\n\n#### " + stripHtmlText(value) + "\n\n")
      .replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, (_m, value) => "\n\n##### " + stripHtmlText(value) + "\n\n")
      .replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, (_m, value) => "\n\n###### " + stripHtmlText(value) + "\n\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/(p|div|section|article|tr|ul|ol|li)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(table|blockquote)>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ");
    return decodeHtmlEntities(text)
      .replace(/[ \t\r\f\v]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n";
  }

  function coEditDocToText(data) {
    if (!window.LiveEditor || !window.LiveEditor.doc2Text) return "";
    const converter = window.LiveEditor.doc2Text;
    if (typeof converter === "function") return converter(data);
    if (converter && typeof converter.docData2Text === "function") return converter.docData2Text(data);
    if (converter && typeof converter.blocks2Text === "function" && data && data.blocks) {
      return converter.blocks2Text(data.blocks);
    }
    return "";
  }

  function textToMarkdown(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n";
  }

  function simpleHtmlToMarkdown(html, assetDirName, reserveResource) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html || "", "text/html");
    doc.querySelectorAll("script, style, meta, link").forEach((node) => node.remove());
    function text(node) {
      if (!node) return "";
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\s+/g, " ");
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const tag = node.tagName.toLowerCase();
      const children = Array.from(node.childNodes).map(text).join("");
      if (/h[1-6]/.test(tag)) return "\n" + "#".repeat(Number(tag.slice(1))) + " " + children.trim() + "\n\n";
      if (tag === "p" || tag === "div" || tag === "section" || tag === "article") return children.trim() ? children.trim() + "\n\n" : "";
      if (tag === "br") return "  \n";
      if (tag === "strong" || tag === "b") return "**" + children.trim() + "**";
      if (tag === "em" || tag === "i") return "*" + children.trim() + "*";
      if (tag === "code") {
        const tick = String.fromCharCode(96);
        return tick + children.trim().replace(new RegExp(tick, "g"), "\\" + tick) + tick;
      }
      if (tag === "pre") {
        const fence = String.fromCharCode(96).repeat(3);
        return "\n" + fence + "\n" + node.textContent.replace(/\n+$/g, "") + "\n" + fence + "\n\n";
      }
      if (tag === "blockquote") return children.split(/\n/).map((line) => line ? "> " + line : ">").join("\n") + "\n\n";
      if (tag === "li") return "- " + children.trim() + "\n";
      if (tag === "ul" || tag === "ol") return "\n" + children + "\n";
      if (tag === "img") {
        const src = node.getAttribute("src") || "";
        const alt = node.getAttribute("alt") || "";
        if (!src) return "";
        if (isExternalResource(src)) return "![" + alt + "](" + src + ")";
        const ref = reserveResource(src);
        return "![" + alt + "](" + markdownUrl(assetDirName + "/" + ref.fileName) + ")";
      }
      if (tag === "a") {
        const href = node.getAttribute("href") || "";
        return href ? "[" + (children.trim() || href) + "](" + href + ")" : children;
      }
      if (tag === "table") return "\n" + node.outerHTML + "\n\n";
      return children;
    }
    return text(doc.body).replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  function createResourceCollector(assetDirName) {
    const refs = [];
    const byName = new Map();
    const usedFileNames = new Set();
    function reserve(src) {
      const source = String(Array.isArray(src) ? src[0] : src || "").trim();
      const resourceName = normalizeResourceName(source);
      if (byName.has(resourceName)) return byName.get(resourceName);
      let fileName = sanitizeFileName(resourceName, "resource");
      const ext = fileName.includes(".") ? fileName.replace(/^.*(\.[^.]+)$/, "$1") : "";
      const base = ext ? fileName.slice(0, -ext.length) : fileName;
      let unique = fileName;
      let n = 2;
      while (usedFileNames.has(unique.toLowerCase())) {
        unique = base + " (" + n + ")" + ext;
        n += 1;
      }
      usedFileNames.add(unique.toLowerCase());
      const ref = { source, resourceName, fileName: unique };
      refs.push(ref);
      byName.set(resourceName, ref);
      return ref;
    }
    function buildResourceUrl(src) {
      const source = String(Array.isArray(src) ? src[0] : src || "").trim();
      if (!source || isExternalResource(source)) return source;
      const ref = reserve(source);
      return markdownUrl(assetDirName + "/" + ref.fileName);
    }
    return { refs, reserve, buildResourceUrl };
  }

  function rewriteIndexFileLinks(markdown, collector, assetDirName) {
    return String(markdown || "").replace(/(!?\[[^\]]*\]\()([^)\s]+index_files\/[^)\s]+)(\))/g, (_m, prefix, src, suffix) => {
      const ref = collector.reserve(src);
      return prefix + markdownUrl(assetDirName + "/" + ref.fileName) + suffix;
    });
  }

  async function getResourceData(note, resourceName) {
    const candidates = [];
    const add = (value) => {
      if (value && !candidates.includes(value)) candidates.push(value);
    };
    add(resourceName);
    try { add(encodeURIComponent(resourceName)); } catch {}
    try { add(decodeURIComponent(resourceName)); } catch {}
    add(basenameFromUrl(resourceName));
    for (const dataId of candidates) {
      const row = await getDataRecord(note.kbGuid, note.docGuid, dataId).catch(() => null);
      if (row && row.data != null && byteLength(row.data) > 0) {
        return {
          ok: true,
          source: "indexeddb",
          dataId,
          base64: await valueToBase64(row.data),
          byteLength: byteLength(row.data),
        };
      }
    }
    return { ok: false, reason: "not-in-indexeddb" };
  }

  async function getEditorResourceData(note, resourceName) {
    const dbs = await getDbInfo();
    const dbInfo = dbs.find((db) => db.name === "wiz-editor-ot-res" && db.stores.includes("cache"));
    if (!dbInfo) return { ok: false, reason: "no-editor-resource-db" };
    const candidates = [];
    const add = (value) => {
      if (value && !candidates.includes(value)) candidates.push(value);
    };
    add(resourceName);
    add(note.kbGuid + ":" + note.docGuid + ":" + resourceName);
    add(note.kbGuid + "/" + note.docGuid + "/" + resourceName);
    add(note.docGuid + ":" + resourceName);
    add(note.docGuid + "/" + resourceName);
    try { add(encodeURIComponent(resourceName)); } catch {}
    try { add(decodeURIComponent(resourceName)); } catch {}
    for (const key of candidates) {
      const row = await getValue("wiz-editor-ot-res", "cache", key).catch(() => null);
      const data = extractResourcePayload(row);
      if (data && byteLength(data) > 0) {
        return {
          ok: true,
          source: "wiz-editor-ot-res",
          dataId: key,
          base64: await valueToBase64(data),
          byteLength: byteLength(data),
        };
      }
    }
    return { ok: false, reason: "not-in-editor-resource-cache" };
  }

  async function getCacheResourceData(note, resourceName) {
    if (!window.caches) return { ok: false, reason: "cache-api-unavailable" };
    const candidates = [];
    const add = (value) => {
      if (value && !candidates.includes(value)) candidates.push(value);
    };
    const base = basenameFromUrl(resourceName);
    add(resourceName);
    add(base);
    const extMatch = base.match(/^(.*)\.[^.]{1,8}$/);
    if (extMatch) add(extMatch[1]);
    try { add(encodeURIComponent(resourceName)); } catch {}
    try { add(decodeURIComponent(resourceName)); } catch {}
    let cache;
    try {
      cache = await caches.open("wiz-note-resource");
    } catch (err) {
      return { ok: false, reason: "cache-open-failed: " + err.message };
    }
    for (const dataId of candidates) {
      const url = "http://wiznote-desktop/note/resources/" + note.kbGuid + "/" + note.docGuid + "/" + dataId;
      const response = await cache.match(url).catch(() => null);
      if (response) {
        const buffer = await response.arrayBuffer();
        return {
          ok: true,
          source: "cache-api:wiz-note-resource",
          dataId,
          base64: arrayBufferToBase64(buffer),
          byteLength: buffer.byteLength,
        };
      }
    }
    return { ok: false, reason: "not-in-cache-api" };
  }

  function extractResourcePayload(row) {
    if (!row) return null;
    if (row instanceof ArrayBuffer || ArrayBuffer.isView(row) || row instanceof Blob || typeof row === "string") return row;
    for (const key of ["data", "blob", "buffer", "body", "content", "value", "file"]) {
      if (row[key] != null) return row[key];
    }
    return null;
  }

  async function fetchRemoteNormalResource(note, kb, resourceName) {
    if (!kb || !kb.kbServer) return { ok: false, reason: "missing-kb-server" };
    const token = await getAccountToken();
    if (!token) return { ok: false, reason: "missing-account-token" };
    const candidates = [];
    const add = (value) => {
      if (value && !candidates.includes(value)) candidates.push(value);
    };
    add(resourceName);
    add(basenameFromUrl(resourceName));
    try { add(decodeURIComponent(resourceName)); } catch {}
    try { add(encodeURIComponent(resourceName)); } catch {}
    let lastReason = "not-on-server";
    for (const dataId of candidates) {
      const url = kb.kbServer + "/ks/object/download/" + note.kbGuid + "/" + note.docGuid + "?objType=resource&objId=" + encodeURIComponent(dataId);
      try {
        const response = await fetchWithTimeout("/__wiz_export_proxy?url=" + encodeURIComponent(url), {
          headers: { "x-wiz-token": token },
        }, 8000);
        if (!response.ok) {
          lastReason = "remote-http-" + response.status;
          continue;
        }
        const buffer = await response.arrayBuffer();
        return {
          ok: true,
          source: "wiznote-server-object",
          dataId,
          base64: arrayBufferToBase64(buffer),
          byteLength: buffer.byteLength,
        };
      } catch (err) {
        lastReason = "remote-error:" + err.message;
      }
    }
    return { ok: false, reason: lastReason };
  }

  async function fetchNormalResource(note, kb, resourceName) {
    const url = "/ks/note/view/" + encodeURIComponent(note.kbGuid) + "/" + encodeURIComponent(note.docGuid) + "/index_files/" + encodeURIComponent(resourceName);
    try {
      const response = await fetchWithTimeout(url, { credentials: "include" }, 5000);
      if (!response.ok) {
        const remote = await fetchRemoteNormalResource(note, kb, resourceName);
        return remote.ok ? remote : { ok: false, reason: "local-http-" + response.status + "; " + remote.reason };
      }
      const buffer = await response.arrayBuffer();
      return {
        ok: true,
        source: "wiznote-local-server",
        base64: arrayBufferToBase64(buffer),
        byteLength: buffer.byteLength,
      };
    } catch (err) {
      const remote = await fetchRemoteNormalResource(note, kb, resourceName);
      return remote.ok ? remote : { ok: false, reason: err.message + "; " + remote.reason };
    }
  }

  async function fetchCoEditResource(note, kb, resourceName, meta) {
    if (!kb || !kb.kbServer) return { ok: false, reason: "missing-kb-server" };
    const candidates = [];
    const add = (value) => {
      if (value && !candidates.includes(value)) candidates.push(value);
    };
    const base = basenameFromUrl(resourceName);
    add(resourceName);
    add(base);
    const extMatch = base.match(/^(.*)\.[^.]{1,8}$/);
    if (extMatch) add(extMatch[1]);
    try {
      const token = await getAccountToken();
      const headers = token ? { "x-wiz-token": token } : {};
      let lastStatus = "";
      const auth = meta && meta.apiServer && meta.token ? meta : await getCoEditResourceAuth(note, kb);
      for (const candidate of candidates) {
        const urls = [];
        if (auth && auth.apiServer && auth.token) {
          urls.push(auth.apiServer + "/resources/" + encodeURIComponent(candidate) + "?token=" + encodeURIComponent(auth.token));
        } else {
          urls.push(kb.kbServer + "/editor/" + note.kbGuid + "/" + note.docGuid + "/resources/" + encodeURIComponent(candidate));
        }
        for (const url of urls) {
          const response = await fetchWithTimeout("/__wiz_export_proxy?url=" + encodeURIComponent(url), { headers }, 5000);
          if (!response.ok) {
            lastStatus = "http-" + response.status;
            continue;
          }
          const buffer = await response.arrayBuffer();
          return {
            ok: true,
            source: "wiznote-server",
            dataId: candidate,
            base64: arrayBufferToBase64(buffer),
            byteLength: buffer.byteLength,
          };
        }
      }
      return { ok: false, reason: lastStatus || "not-on-server" };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  async function fillResourceData(note, kb, ref, meta) {
    let result = await getResourceData(note, ref.resourceName);
    if (!result.ok) {
      result = await getCacheResourceData(note, ref.resourceName);
    }
    if (!result.ok && isCoEdit(note.type)) {
      result = await getEditorResourceData(note, ref.resourceName);
    }
    if (!result.ok) {
      result = isCoEdit(note.type)
        ? await fetchCoEditResource(note, kb, ref.resourceName, meta)
        : await fetchNormalResource(note, kb, ref.resourceName);
    }
    return {
      ...result,
      originalSource: ref.source,
      resourceName: ref.resourceName,
      fileName: ref.fileName,
      fetchSource: result.source,
    };
  }

  async function convertNote(payload) {
    await installLiveEditor();
    const { note, kb, assetDirName } = payload;
    const collector = createResourceCollector(assetDirName);
    let markdown = "";
    let source = "";
    let missingBody = false;
    let coEditMeta = null;

    try {
      if (isCoEdit(note.type)) {
        let data = await withTimeout(
          window.LiveEditor.getOfflineDocData(note.kbGuid, note.docGuid),
          30000,
          "getOfflineDocData"
        );
        if (!data && payload.fetchMissing && kb && kb.kbServer && window.LiveEditor.syncOfflineDoc) {
          const synced = await withTimeout(
            window.LiveEditor.syncOfflineDoc(
              kb.kbServer,
              note.kbGuid,
              note.docGuid,
              30000,
              async () => getCoEditEditorAuth(note, kb)
            ),
            45000,
            "syncOfflineDoc"
          );
          if (synced) {
            data = await withTimeout(
              window.LiveEditor.getOfflineDocData(note.kbGuid, note.docGuid),
              10000,
              "getOfflineDocData"
            );
            source = "live-editor-server-sync";
          } else {
            source = "live-editor-server-sync-failed";
          }
        }
        if (!data) {
          missingBody = true;
        } else {
          coEditMeta = data.meta || null;
          if (!source) source = "live-editor-offline-doc";
          if (payload.plainText) {
            source += "-plain-text";
            markdown = textToMarkdown(coEditDocToText(data));
          } else {
            markdown = await withTimeout(
              window.LiveEditor.doc2markdown(data, {
                keepImageSize: false,
                keepComments: true,
                buildResourceUrl: collector.buildResourceUrl,
              }),
              30000,
              "doc2markdown"
            );
          }
        }
      } else {
        let htmlData = await getHtmlData(note);
        if (!htmlData.html && payload.fetchMissing) {
          htmlData = await fetchRemoteDocData(note, kb);
        }
        source = htmlData.source;
        if (!htmlData.html) {
          missingBody = true;
        } else if (!payload.simpleHtml && window.LiveEditor && window.LiveEditor.html2Doc && window.LiveEditor.doc2markdown) {
          const doc = await withTimeout(
            window.LiveEditor.html2Doc(htmlData.html, { convertFont: false, convertList: true }),
            30000,
            "html2Doc"
          );
          markdown = await withTimeout(
            window.LiveEditor.doc2markdown(doc, {
              keepImageSize: false,
              keepComments: true,
              buildResourceUrl: collector.buildResourceUrl,
            }),
            30000,
            "doc2markdown"
          );
        } else {
          if (payload.simpleHtml) source = source ? source + "-simple-html" : "simple-html";
          markdown = simpleHtmlToMarkdown(htmlData.html, assetDirName, collector.reserve);
        }
      }

      markdown = String(markdown || "")
        .replace(/(!\[[^[\]]*\]\([^=]*?)\s+=\d+x\d*\s*(\))/gm, "$1$2");
      markdown = rewriteIndexFileLinks(markdown, collector, assetDirName);

      const resources = [];
      for (const ref of collector.refs) {
        resources.push(await fillResourceData(note, kb, ref, coEditMeta));
      }

      return {
        ok: !missingBody,
        missingBody,
        source,
        markdown,
        resources,
      };
    } catch (err) {
      return {
        ok: false,
        missingBody,
        source,
        error: err && err.message ? err.message : String(err),
        markdown,
        resources: collector.refs,
      };
    }
  }

  helper.installLiveEditor = installLiveEditor;
  helper.health = async () => ({
    href: location.href,
    liveEditorReady: !!window.LiveEditor,
    liveEditorKeys: window.LiveEditor ? Object.keys(window.LiveEditor).filter((k) => /markdown|html2Doc|getOfflineDocData/.test(k)) : [],
  });
  helper.readSnapshot = readSnapshot;
  helper.convertNote = convertNote;
  window.__WIZ_EXPORT__ = helper;
}
`;
}

async function readSnapshot(args) {
  return withBrowser(args, async (cdp, runtime) => {
    const snapshot = await cdp.evaluate("window.__WIZ_EXPORT__.readSnapshot()");
    snapshot.runtime = runtime;
    return snapshot;
  }, { includeResourceCache: false });
}

function settingValue(row) {
  const value = row.value;
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (Object.prototype.hasOwnProperty.call(value, "value")) return value.value;
  if (Object.prototype.hasOwnProperty.call(value, "v")) return value.v;
  return value;
}

function settingKey(row) {
  if (typeof row.key === "string") return row.key;
  if (row.value && typeof row.value.key === "string") return row.value.key;
  return JSON.stringify(row.key);
}

function normalizeDoc(row) {
  return { ...row.value, _key: row.key };
}

function normalizeFolder(row) {
  return { ...row.value, _key: row.key };
}

function normalizeKb(row) {
  return { ...row.value, _key: row.key };
}

function normalizeAttachment(row) {
  return { ...row.value, _key: row.key };
}

function isCoEdit(type) {
  return String(type || "").toLowerCase().startsWith("collaboration");
}

function dataKey(kbGuid, docGuid, dataId) {
  return `${kbGuid}\u0000${docGuid}\u0000${dataId}`;
}

function editorKeyVariants(kbGuid, docGuid) {
  return new Set([
    `${kbGuid}:${docGuid}`,
    `${kbGuid}/${docGuid}`,
    `${kbGuid}\u0000${docGuid}`,
    docGuid,
  ]);
}

function buildIndexes(snapshot) {
  const docs = snapshot.docs.map(normalizeDoc).filter((doc) => doc && doc.docGuid && doc.kbGuid);
  const folders = snapshot.folders.map(normalizeFolder);
  const kbs = snapshot.kbs.map(normalizeKb);
  const attachments = snapshot.attachments.map(normalizeAttachment);
  const kbsByGuid = new Map(kbs.map((kb) => [kb.kbGuid, kb]));
  const dataIndex = new Map();
  for (const row of snapshot.dataIndex) {
    dataIndex.set(dataKey(row.kbGuid, row.docGuid, row.dataId), row);
  }
  const editorDocKeys = new Set(snapshot.editorDocKeys.map((key) => String(key)));
  const attachmentsByDoc = new Map();
  for (const att of attachments) {
    const key = `${att.kbGuid}\u0000${att.docGuid}`;
    if (!attachmentsByDoc.has(key)) attachmentsByDoc.set(key, []);
    attachmentsByDoc.get(key).push(att);
  }
  return { docs, folders, kbs, kbsByGuid, attachments, attachmentsByDoc, dataIndex, editorDocKeys };
}

function noteHasLocalBody(doc, indexes) {
  if (isCoEdit(doc.type)) {
    const variants = editorKeyVariants(doc.kbGuid, doc.docGuid);
    for (const key of variants) {
      if (indexes.editorDocKeys.has(key)) return true;
    }
    return false;
  }
  const row = indexes.dataIndex.get(dataKey(doc.kbGuid, doc.docGuid, "index.html"));
  return !!(row && row.hasData && row.dataBytes > 0);
}

function statusFromSnapshot(snapshot) {
  const indexes = buildIndexes(snapshot);
  const settings = {};
  for (const row of snapshot.settings2) {
    const key = settingKey(row);
    if (/sync\./.test(key)) settings[key] = settingValue(row);
  }
  const missing = [];
  const bodyBreakdown = {
    collaboration: { total: 0, present: 0, missing: 0 },
    standardHtml: { total: 0, present: 0, missing: 0 },
  };
  for (const doc of indexes.docs) {
    const kind = isCoEdit(doc.type) ? "collaboration" : "standardHtml";
    const present = noteHasLocalBody(doc, indexes);
    bodyBreakdown[kind].total += 1;
    if (present) bodyBreakdown[kind].present += 1;
    else bodyBreakdown[kind].missing += 1;
    if (!present) missing.push(doc);
  }
  const docsWithAttachments = indexes.docs.filter((doc) =>
    indexes.attachmentsByDoc.has(`${doc.kbGuid}\u0000${doc.docGuid}`)
  ).length;
  const resourceRows = snapshot.dataIndex.filter((row) => row.dataType === "resource" && row.hasData);
  const editorResources = snapshot.editorResources || [];
  const cacheResources = snapshot.cacheResources || [];
  return {
    userDbName: snapshot.userDbName,
    counts: snapshot.counts,
    docsTotal: indexes.docs.length,
    foldersTotal: indexes.folders.length,
    kbs: indexes.kbs.map((kb) => ({
      kbGuid: kb.kbGuid,
      name: kb.name || kb.kbName || "",
      noteCount: kb.noteCount,
      dataProgress: kb.dataProgress,
      kbServer: kb.kbServer,
    })),
    syncSettings: settings,
    localBodies: {
      ready: missing.length === 0,
      missing: missing.length,
      present: indexes.docs.length - missing.length,
      byKind: bodyBreakdown,
      sampleMissing: missing.slice(0, 10).map((doc) => ({
        title: doc.title,
        docGuid: doc.docGuid,
        category: doc.category,
        type: doc.type || "",
        status: doc.status || "",
      })),
    },
    resources: {
      localResourceRows: resourceRows.length,
      editorResourceRows: editorResources.length,
      editorResourceSample: editorResources.slice(0, 5),
      cacheResourceRows: cacheResources.length,
      cacheResourceSample: cacheResources.slice(0, 10),
    },
    attachments: {
      total: indexes.attachments.length,
      docsWithAttachments,
      stage: "metadata-only-in-stage-1",
    },
    runtime: snapshot.runtime,
  };
}

function printStatus(status) {
  console.log(`WizNote DB: ${status.userDbName}`);
  console.log(`Notes: ${status.docsTotal}`);
  console.log(`Folders: ${status.foldersTotal}`);
  console.log(`Local note bodies: ${status.localBodies.present}/${status.docsTotal}`);
  if (status.localBodies.byKind) {
    const co = status.localBodies.byKind.collaboration;
    const html = status.localBodies.byKind.standardHtml;
    console.log(`  collaboration: ${co.present}/${co.total}`);
    console.log(`  standard HTML: ${html.present}/${html.total}`);
  }
  if (!status.localBodies.ready) {
    console.log(`Missing local bodies: ${status.localBodies.missing}`);
  }
  console.log(`Attachments: ${status.attachments.total} (stage 1 records metadata only)`);
  console.log(`Local body resources: ${status.resources.localResourceRows}`);
  console.log(`Editor resource cache rows: ${status.resources.editorResourceRows}`);
  console.log(`Cache API resource rows: ${status.resources.cacheResourceRows}`);
  console.log("Sync settings:");
  for (const [key, value] of Object.entries(status.syncSettings)) {
    console.log(`  ${key}: ${JSON.stringify(value)}`);
  }
  console.log("Knowledge bases:");
  for (const kb of status.kbs) {
    console.log(`  ${kb.name || kb.kbGuid}: dataProgress=${kb.dataProgress ?? "unknown"}, noteCount=${kb.noteCount ?? "unknown"}`);
  }
  if (status.localBodies.sampleMissing.length) {
    console.log("Sample missing notes:");
    for (const doc of status.localBodies.sampleMissing) {
      console.log(`  - ${doc.title || doc.docGuid} (${doc.status || "unknown"})`);
    }
  }
}

function sanitizePathSegment(segment, fallback = "Untitled") {
  let out = String(segment || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!out) out = fallback;
  if (out.length > 120) out = out.slice(0, 120).trim();
  return out;
}

function stripMarkdownExt(title) {
  return String(title || "Untitled").replace(/\.md$/i, "");
}

function categorySegments(category) {
  return String(category || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => sanitizePathSegment(part, "Folder"));
}

function tagsFromDoc(doc) {
  return String(doc.tags || "")
    .split(/[,*]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function isoTime(value) {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const date = new Date(n);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function yamlString(value) {
  return JSON.stringify(value == null ? "" : String(value));
}

function frontmatter(doc, attachments) {
  const lines = ["---"];
  lines.push(`title: ${yamlString(doc.title || "")}`);
  lines.push(`wiznote_doc_guid: ${yamlString(doc.docGuid)}`);
  lines.push(`wiznote_kb_guid: ${yamlString(doc.kbGuid)}`);
  lines.push(`wiznote_category: ${yamlString(doc.category || "")}`);
  lines.push(`wiznote_type: ${yamlString(doc.type || "")}`);
  const created = isoTime(doc.created);
  const updated = isoTime(doc.dataModified || doc.infoModified);
  if (created) lines.push(`created: ${yamlString(created)}`);
  if (updated) lines.push(`updated: ${yamlString(updated)}`);
  const tags = tagsFromDoc(doc);
  lines.push("tags:");
  for (const tag of tags) lines.push(`  - ${yamlString(tag)}`);
  lines.push(`wiznote_attachment_count: ${attachments.length}`);
  lines.push("---");
  return `${lines.join("\n")}\n\n`;
}

function noteOutputPlan(docs, outDir) {
  const used = new Map();
  return docs.map((doc) => {
    const dirSegments = categorySegments(doc.category);
    const dir = path.join(outDir, ...dirSegments);
    const baseRaw = sanitizePathSegment(stripMarkdownExt(doc.title), doc.docGuid);
    const key = dir.toLowerCase();
    if (!used.has(key)) used.set(key, new Set());
    const localUsed = used.get(key);
    let base = baseRaw;
    let n = 2;
    while (localUsed.has(`${base.toLowerCase()}.md`)) {
      base = `${baseRaw} (${n})`;
      n += 1;
    }
    localUsed.add(`${base.toLowerCase()}.md`);
    return {
      doc,
      dir,
      fileName: `${base}.md`,
      filePath: path.join(dir, `${base}.md`),
      assetDirName: `${base}.assets`,
      assetDir: path.join(dir, `${base}.assets`),
      relativePath: path.join(...dirSegments, `${base}.md`),
    };
  });
}

async function writeBase64File(filePath, base64) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, Buffer.from(base64, "base64"));
}

async function runStatus(args) {
  const snapshot = await readSnapshot(args);
  const status = statusFromSnapshot(snapshot);
  if (args.json) console.log(JSON.stringify(status, null, 2));
  else printStatus(status);
  return status;
}

async function waitUntilReady(args) {
  for (;;) {
    const status = await runStatus({ ...args, json: false });
    if (status.localBodies.ready) return status;
    log(args, `Local bodies are incomplete. Waiting ${Math.round(args.pollMs / 1000)}s before retry...`);
    await sleep(args.pollMs);
  }
}

async function evaluateWithTimeout(cdp, expression, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      cdp.evaluate(expression),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${label} timed out after ${timeoutMs}ms`);
          err.code = "WIZ_EXPORT_EVALUATE_TIMEOUT";
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isEvaluateTimeout(err) {
  return err && err.code === "WIZ_EXPORT_EVALUATE_TIMEOUT";
}

async function runExport(args) {
  let snapshot;
  let status;
  let indexes;
  let docs;
  let blockedMissing;

  for (;;) {
    snapshot = await readSnapshot(args);
    status = statusFromSnapshot(snapshot);
    indexes = buildIndexes(snapshot);
    docs = indexes.docs.slice().sort((a, b) => {
      const ca = String(a.category || "");
      const cb = String(b.category || "");
      if (ca !== cb) return ca.localeCompare(cb);
      return String(a.title || "").localeCompare(String(b.title || ""));
    });
    if (args.coeditOnly) docs = docs.filter((doc) => isCoEdit(doc.type));
    if (args.only) docs = docs.filter((doc) => doc.docGuid === args.only);
    if (args.limit) docs = docs.slice(0, args.limit);
    blockedMissing = docs.filter((doc) => !noteHasLocalBody(doc, indexes) && !args.fetchMissing);
    if (!args.wait || !blockedMissing.length) break;
    log(args, `Selected note bodies are incomplete (${docs.length - blockedMissing.length}/${docs.length}). Waiting ${Math.round(args.pollMs / 1000)}s before retry...`);
    await sleep(args.pollMs);
  }

  if (blockedMissing.length && !args.allowPartial) {
    const message =
      `Selected note bodies are incomplete (${docs.length - blockedMissing.length}/${docs.length}). ` +
      (args.coeditOnly
        ? "Collaboration notes require local LiveEditor data; keep WizNote sync running, then rerun. "
        : "Open WizNote settings, set offline sync to all notes, wait for sync to finish, then rerun. ") +
      "Use --allow-partial only for a partial verification export.";
    if (args.json) console.log(JSON.stringify({ ok: false, status, message, missing: blockedMissing.slice(0, 20) }, null, 2));
    else {
      printStatus(status);
      console.error(`\n${message}`);
      for (const doc of blockedMissing.slice(0, 10)) {
        console.error(`  - ${doc.title || doc.docGuid}`);
      }
    }
    process.exitCode = 2;
    return;
  }

  const skippedForMissing = [];
  if (args.allowPartial) {
    const kept = [];
    for (const doc of docs) {
      const canFetchDuringExport = args.fetchMissing;
      if (noteHasLocalBody(doc, indexes) || canFetchDuringExport) kept.push(doc);
      else skippedForMissing.push(doc);
    }
    docs = kept;
  }

  await fsp.mkdir(args.out, { recursive: true });
  const plans = noteOutputPlan(docs, args.out);
  const manifest = {
    generatedAt: new Date().toISOString(),
    stage: "stage-1-no-attachments",
    sourceProfile: args.profile,
    outputDir: args.out,
    status,
    notes: [],
    skipped: [],
  };

  for (const doc of skippedForMissing) {
    manifest.skipped.push({
      docGuid: doc.docGuid,
      title: doc.title || "",
      category: doc.category || "",
      reason: "missing-local-body",
    });
  }

  const makeNoteRecord = (plan, result, attachments) => ({
    docGuid: plan.doc.docGuid,
    kbGuid: plan.doc.kbGuid,
    title: plan.doc.title || "",
    category: plan.doc.category || "",
    markdownPath: path.relative(args.out, plan.filePath),
    assetDir: path.relative(args.out, plan.assetDir),
    source: result.source,
    ok: !!result.ok,
    resources: [],
    attachments: attachments.map((att) => ({
      attGuid: att.attGuid,
      name: att.name,
      dataSize: att.dataSize,
      status: att.status,
      stage: "metadata-only",
    })),
  });

  log(args, `Exporting ${plans.length} notes to ${args.out}`);
  let current = 0;
  while (current < plans.length) {
    let restartBrowser = false;
    await withBrowser(args, async (cdp) => {
      while (current < plans.length && !restartBrowser) {
        const displayIndex = current + 1;
        const plan = plans[current];
        const doc = plan.doc;
        const attachmentKey = `${doc.kbGuid}\u0000${doc.docGuid}`;
        const attachments = indexes.attachmentsByDoc.get(attachmentKey) || [];
        const kb = indexes.kbsByGuid.get(doc.kbGuid) || {};
        const expression = `window.__WIZ_EXPORT__.convertNote(${JSON.stringify({
          note: doc,
          kb,
          assetDirName: plan.assetDirName,
          fetchMissing: args.fetchMissing,
          simpleHtml: args.simpleHtml || !!plan.simpleHtmlAttempt,
          plainText: !!plan.plainTextAttempt,
        })})`;
        let result;
        const hasLocalBody = noteHasLocalBody(doc, indexes);
        const convertTimeoutMs = hasLocalBody ? Math.min(args.noteTimeoutMs, 30000) : args.noteTimeoutMs;
        try {
          result = await evaluateWithTimeout(cdp, expression, convertTimeoutMs, `convert ${doc.docGuid}`);
        } catch (err) {
          if (!isEvaluateTimeout(err)) throw err;
          if (isCoEdit(doc.type) && !plan.plainTextAttempt) {
            plan.plainTextAttempt = true;
            log(args, `[${displayIndex}/${plans.length}] retrying ${doc.title || doc.docGuid} with plain text converter after timeout`);
            restartBrowser = true;
            return;
          }
          if (!isCoEdit(doc.type) && !plan.simpleHtmlAttempt) {
            plan.simpleHtmlAttempt = true;
            log(args, `[${displayIndex}/${plans.length}] retrying ${doc.title || doc.docGuid} with simple HTML converter after timeout`);
            restartBrowser = true;
            return;
          }
          result = {
            ok: false,
            source: "timeout",
            error: err.message,
            resources: [],
          };
          const noteRecord = makeNoteRecord(plan, result, attachments);
          noteRecord.error = result.error;
          manifest.notes.push(noteRecord);
          log(args, `[${displayIndex}/${plans.length}] skipped ${doc.title || doc.docGuid}: ${noteRecord.error}`);
          current += 1;
          restartBrowser = true;
          return;
        }

        const noteRecord = makeNoteRecord(plan, result, attachments);

        if (!result.ok) {
          noteRecord.error = result.error || (result.missingBody ? "missing-local-body" : "conversion-failed");
          if (!isCoEdit(doc.type) && !plan.simpleHtmlAttempt && /timed out/i.test(noteRecord.error)) {
            plan.simpleHtmlAttempt = true;
            log(args, `[${displayIndex}/${plans.length}] retrying ${doc.title || doc.docGuid} with simple HTML converter after ${noteRecord.error}`);
            restartBrowser = true;
            return;
          }
          if (isCoEdit(doc.type) && !plan.plainTextAttempt && /timed out/i.test(noteRecord.error)) {
            plan.plainTextAttempt = true;
            log(args, `[${displayIndex}/${plans.length}] retrying ${doc.title || doc.docGuid} with plain text converter after ${noteRecord.error}`);
            restartBrowser = true;
            return;
          }
          manifest.notes.push(noteRecord);
          log(args, `[${displayIndex}/${plans.length}] skipped ${doc.title || doc.docGuid}: ${noteRecord.error}`);
          current += 1;
          continue;
        }

        const markdown = frontmatter(doc, attachments) + String(result.markdown || "").trimEnd() + "\n";
        await fsp.mkdir(path.dirname(plan.filePath), { recursive: true });
        await fsp.writeFile(plan.filePath, markdown, "utf8");

        for (const resource of result.resources || []) {
          const resourceRecord = {
            source: resource.originalSource || resource.source,
            resourceName: resource.resourceName,
            fileName: resource.fileName,
            ok: !!resource.ok,
            reason: resource.reason,
            fetchSource: resource.fetchSource || resource.source,
            byteLength: resource.byteLength || 0,
          };
          if (resource.ok && resource.base64) {
            const filePath = path.join(plan.assetDir, resource.fileName);
            await writeBase64File(filePath, resource.base64);
            resourceRecord.path = path.relative(args.out, filePath);
          }
          noteRecord.resources.push(resourceRecord);
        }

        manifest.notes.push(noteRecord);
        if (!args.json) {
          const missingResources = noteRecord.resources.filter((r) => !r.ok).length;
          const resourceText = noteRecord.resources.length
            ? `, resources ${noteRecord.resources.length - missingResources}/${noteRecord.resources.length}`
            : "";
          console.log(`[${displayIndex}/${plans.length}] ${path.relative(args.out, plan.filePath)}${resourceText}`);
        }
        current += 1;
      }
    }, { includeResourceCache: true });
  }

  const manifestPath = path.join(args.out, "_wiz_export_manifest.json");
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const summary = {
    ok: true,
    outputDir: args.out,
    manifestPath,
    notesWritten: manifest.notes.filter((note) => note.ok).length,
    notesFailed: manifest.notes.filter((note) => !note.ok).length,
    skippedMissingBodies: manifest.skipped.length,
    resourcesMissing: manifest.notes.flatMap((note) => note.resources || []).filter((resource) => !resource.ok).length,
    attachmentsMetadataOnly: manifest.notes.reduce((sum, note) => sum + (note.attachments ? note.attachments.length : 0), 0),
  };
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`\nDone. Notes written: ${summary.notesWritten}`);
    if (summary.notesFailed) console.log(`Notes failed: ${summary.notesFailed}`);
    if (summary.resourcesMissing) console.log(`Missing body resources: ${summary.resourcesMissing}`);
    if (summary.attachmentsMetadataOnly) console.log(`Attachments recorded for stage 2: ${summary.attachmentsMetadataOnly}`);
    console.log(`Manifest: ${manifestPath}`);
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
    if (args.command === "help") {
      console.log(usage());
      return;
    }
    if (!(await pathExists(args.profile))) throw new Error(`WizNote profile not found: ${args.profile}`);
    if (!(await pathExists(args.liveEditor))) throw new Error(`LiveEditor bundle not found: ${args.liveEditor}`);
    if (args.command === "status") await runStatus(args);
    else if (args.command === "export") await runExport(args);
  } catch (err) {
    if (args && args.json) console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    else {
      console.error(err.stack || err.message);
      console.error("");
      console.error(usage());
    }
    process.exitCode = 1;
  }
}

main();
