# WizNote Markdown Export

Export WizNote desktop notes to Markdown on macOS while preserving folder structure and local resources.

This project is designed for migration out of WizNote into tools such as Obsidian or SiYuan. It works against the local WizNote desktop profile and reuses parts of WizNote's own local data model and editor conversion flow.

Chinese documentation: [README.zh-CN.md](README.zh-CN.md)

## Status

- macOS only
- works with the WizNote desktop app profile
- not an official WizNote tool
- built from observed WizNote desktop behavior, so future app updates can break it
- tested against WizNote for macOS `0.1.107`

## What It Exports

- note tree as directories
- note body as Markdown
- body images/resources into a sibling `*.assets/` directory
- collaboration note body links as local attachments
- export manifests for resume, retry, and verification

The primary output of this project is Markdown. Raw HTML is not the primary migration artifact.

> ⚠️ **Warning**
> `upgrade-legacy` is a write-back operation. It converts legacy HTML notes into `lite/markdown` and uploads the converted result back into WizNote. This changes the original note type and can change the original note content shape. Use normal `export` if you want Markdown output without modifying source notes.

## Current Export Policy

- Normal `export` is read-only to your WizNote data. For old HTML notes and older `webnote` clippings, it can directly convert the current note content into exported Markdown without writing back to WizNote.
- `upgrade-legacy` is optional and destructive to source data shape. It rewrites old HTML notes inside WizNote as `lite/markdown`.
- Collaboration comments are intentionally not exported.
- Markdown is the target format, including for old web-clipping notes.
- Missing collaboration resources can fall back to the original WizNote profile cache on disk.
- Export manifests are merged with a short lock so narrow retry jobs can run in parallel.

## Supported Note Shapes

- collaboration notes
- `lite/markdown` notes
- legacy HTML notes, through direct HTML-to-Markdown export
- web-clipping notes, including older `webnote` items
- optional pre-export write-back upgrade for old ordinary HTML notes via `upgrade-legacy`

Very old notes may still need fallback conversion or manual review.

## Quick Start

Requirements:

- macOS
- WizNote desktop app installed
- Node.js 24+
- Google Chrome, Chromium, or Microsoft Edge installed locally

Other Chromium-based browsers can still work, but you must set `CHROME_PATH` to the browser binary path because auto-discovery only checks the three apps above.

Check local readiness:

```bash
npm run status
```

Before a large export, open WizNote `Settings -> Sync Settings` and set both `Offline Personal Notes` and `Offline Group Notes (Legacy Notes)` to `All Notes`. In the tested build, those offline settings explicitly exclude attachments.

After changing those settings, wait for WizNote's own background sync to catch up before starting a large export. In practice, WizNote's offline sync can be slow even when it is working normally, so users should expect to wait patiently at this stage. Local fully-synced exports are usually much faster and more reliable. `--fetch-missing` can bypass part of that wait, but it is a fallback path and usually less stable than exporting after local sync finishes.

Run a first export:

```bash
node scripts/wiz-export.js export --out ./export --fetch-missing
```

Resume an existing export:

```bash
node scripts/wiz-export.js export --out ./export --fetch-missing --attachments --resume
```

Verify and rebuild the manifest from files on disk:

```bash
node scripts/wiz-export.js verify --out ./export --rewrite-manifest
```

## Output Layout

Each note is written as:

```text
Category/Subcategory/Note.md
Category/Subcategory/Note.assets/
```

This keeps Markdown, images, and local file links together so a subtree can be copied or archived without breaking relative links.

## Documentation

- [README.zh-CN.md](README.zh-CN.md)
- [docs/USAGE.md](docs/USAGE.md)
- [docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md)
- [docs/POST_IMPORT.md](docs/POST_IMPORT.md)
- [docs/POST_IMPORT.zh-CN.md](docs/POST_IMPORT.zh-CN.md)
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- [docs/TROUBLESHOOTING.zh-CN.md](docs/TROUBLESHOOTING.zh-CN.md)
