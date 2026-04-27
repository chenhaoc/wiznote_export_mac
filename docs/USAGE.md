# Usage

Tested with WizNote for macOS `0.1.107`.

## Core Commands

Check local readiness:

```bash
npm run status
```

Before a large export, open WizNote settings and confirm offline note download is set to all notes:

1. Open `Settings`
2. Open `Sync Settings`
3. Set `Offline Personal Notes` to `All Notes`
4. Set `Offline Group Notes (Legacy Notes)` to `All Notes`

In the tested WizNote build, those settings explicitly say the offline data does not include attachments. Attachments still need exporter-side handling.

After enabling those settings, do not immediately start a large export. Wait for WizNote background sync to download note bodies locally first. In practice, WizNote's own offline sync can be slow even when it is functioning normally, so patience is part of the workflow. A fully-synced local export is usually both faster and more reliable.

`--fetch-missing` exists for cases where waiting is too slow, but it should be treated as a recovery path rather than the preferred happy path.

Normal `export` is read-only to your WizNote data. It can convert legacy HTML notes and older `webnote` content directly into exported Markdown without rewriting the original notes inside WizNote.

Export all notes:

```bash
node scripts/wiz-export.js export --out ./export --fetch-missing
```

Resume an existing export:

```bash
node scripts/wiz-export.js export --out ./export --fetch-missing --attachments --resume
```

Verify exported files and rebuild the manifest:

```bash
node scripts/wiz-export.js verify --out ./export --rewrite-manifest
```

## Common Workflows

### 1. First full migration

```bash
node scripts/wiz-export.js export --out ./export --fetch-missing --attachments --resume
```

### 2. Export only collaboration notes

```bash
node scripts/wiz-export.js export --out ./export --coedit-only --attachments
```

### 3. Export only web-clipping notes

```bash
node scripts/wiz-export.js export --out ./export --fetch-missing --resume --web-clips-only
```

### 4. Add attachments later without reconverting bodies

```bash
node scripts/wiz-export.js export --out ./export --attachments-only
```

You can also split attachment handling:

```bash
node scripts/wiz-export.js export --out ./export --legacy-attachments-only
node scripts/wiz-export.js export --out ./export --body-attachments-only
```

### 5. Upgrade old ordinary notes before export

```bash
node scripts/wiz-export.js upgrade-legacy --out ./export --dry-run --limit 20
node scripts/wiz-export.js upgrade-legacy --out ./export --resume --yes
```

`upgrade-legacy` is not just metadata cleanup. It converts old ordinary HTML notes into WizNote-compatible `lite/markdown`, uploads that converted result back through the WizNote API, and only then do later exports treat those notes like normal Markdown notes.

This is a write-back operation. It changes the original note type inside WizNote and can change the original note content shape. The command now requires an interactive confirmation unless you pass `--yes`.

Use `upgrade-legacy` only when you explicitly want to change the source notes inside WizNote. If you only want Markdown export, use normal `export`.

## Important Options

- `--fetch-missing`: ask the WizNote server for missing note bodies/resources
- `--resume`: skip notes that already have a fresh Markdown export
- `--attachments`: download collaboration body-link attachments during export
- `--attachments-only`: only update attachments on an existing export
- `--coedit-only`: process collaboration notes only
- `--web-clips-only`: process web-clipping notes only
- `--skip-web-clips`: skip web-clipping notes
- `--yes`: skip the destructive-operation confirmation for `upgrade-legacy`
- `--failed-only`: retry only manifest-recorded failures
- `--degraded-only`: retry only lossy fallback exports
- `--only DOC_GUID`: process one note
- `--limit N`: process only a limited number of notes
- `--note-timeout-ms N`: per-note conversion timeout
- `--attachment-timeout-ms N`: per attachment/resource timeout

## Output Files

The exporter writes:

- Markdown note files
- sibling `*.assets/` resource directories
- `_wiz_export_manifest.json`
- `_wiz_upgrade_manifest.json` when running `upgrade-legacy`

The exporter is Markdown-oriented. It does not use raw HTML as the final migration artifact. Normal `export` can directly convert legacy HTML and older `webnote` content into Markdown output without writing back to WizNote. `upgrade-legacy` is the separate command that rewrites old ordinary HTML notes inside WizNote as `lite/markdown`.

## Manifest Role

The export manifest is used for:

- resume decisions
- retry targeting
- resource/attachment status
- current-state verification

`verify --rewrite-manifest` is the fastest way to rebuild the manifest from exported files if the process was interrupted or repaired manually.
