# WizNote Markdown Export

Two-stage exporter for migrating WizNote desktop notes to Obsidian or SiYuan.

Stage 1 exports:

- folder tree as directories
- note body as Markdown
- images/resources referenced by note body into per-note `.assets` folders
- export manifest with skipped notes, missing resources, and attachment metadata counts

WizNote's "download all notes" setting helps before a full export, but it should be understood as "download all note bodies". Attachments are separate objects and are not included in that offline setting. Body images/resources are mixed: some are already local, some are in the editor resource cache, and some need to be downloaded from WizNote's resource server during export.

For legacy ordinary notes, prefer upgrading them to WizNote's `lite/markdown` format first with `upgrade-legacy`. The command reuses the same LiveEditor conversion path as the desktop client's title-left "upgrade to realtime Markdown" button, but drives it through authenticated WizNote server APIs instead of UI clicks. `export --fetch-missing` then downloads note bodies and resources from the server first, using the local WizNote view server only as a fallback.

Stage 2 adds collaboration-note file attachments: local Markdown file links such as `[office](...)` are rewritten into the note's `.assets/` directory and downloaded through the same authenticated resource path used for collaboration images.

## Commands

Check whether local data is ready:

```bash
npm run status
```

Export after WizNote has downloaded all notes:

```bash
node scripts/wiz-export.js export --out ./export
```

If WizNote's own sync is too slow, fetch or sync missing note bodies from the WizNote server during export:

```bash
node scripts/wiz-export.js export --out ./export --fetch-missing
```

This bypass does not write anything back into the WizNote client database. It is intended to speed up migration for notes whose bodies have not arrived locally yet. The exporter asks the WizNote server first; keep the real WizNote desktop app open only when you want the local view server fallback available for unusual notes.
If the richer editor converter hangs on a complex legacy HTML note, the exporter restarts its temporary browser and retries that note with a simpler HTML converter.
For collaboration notes, plain-text fallback is treated as a degraded failed export, not a successful migration, because it can lose tables, images, and other structured blocks.

Upgrade legacy ordinary notes before a full export:

```bash
node scripts/wiz-export.js upgrade-legacy --out ./export --dry-run --limit 20
node scripts/wiz-export.js upgrade-legacy --out ./export --resume
```

`upgrade-legacy` writes `_wiz_upgrade_manifest.json` into the output directory. Use `--dry-run` first to verify server download and conversion without changing WizNote data. Without `--dry-run`, the command uploads a `lite/markdown` body back to WizNote and preserves the original modified time, matching the desktop client's upgrade behavior. Problematic notes are recorded in the manifest and can be analyzed together after the batch run.

Resume an interrupted export and only process notes that are missing or stale:

```bash
node scripts/wiz-export.js export --out ./export --fetch-missing --attachments --resume
```

Resume mode first uses the existing manifest, then falls back to the target Markdown frontmatter. A note is skipped only when the target `.md` exists, `wiznote_doc_guid` matches, and the exported `updated` timestamp is not older than the note's current modified time. If the frontmatter is missing, it falls back to file mtime. When combined with `--limit`, the limit applies after fresh notes are skipped, so it processes the next N unfinished notes.

For a first full pass, skip known slow web clippings and failed retries so ordinary notes can finish first:

```bash
node scripts/wiz-export.js export --out ./export --fetch-missing --attachments --resume --skip-failed --skip-web-clips
```

Export only collaboration notes and skip legacy HTML notes:

```bash
node scripts/wiz-export.js export --out ./export-coedit --coedit-only --attachments
```

Add attachments to an existing export without reconverting note bodies. This downloads collaboration body links and legacy ordinary-note attachments into each note's `.assets/` directory:

```bash
node scripts/wiz-export.js export --out ./export-coedit --attachments-only
```

When one attachment class is slow, process it separately:

```bash
node scripts/wiz-export.js export --out ./export-coedit --legacy-attachments-only
node scripts/wiz-export.js export --out ./export-coedit --body-attachments-only
```

Retry only notes that are currently recorded as failed in the manifest:

```bash
node scripts/wiz-export.js export --out ./export-coedit --fetch-missing --attachments --resume --failed-only --skip-web-clips
```

If WizNote is still syncing and you want to export only notes that already have local bodies:

```bash
node scripts/wiz-export.js export --out ./export --allow-partial
```

Useful options:

- `--wait`: wait until local note bodies look complete before exporting
- `--fetch-missing`: download/sync missing note bodies during export instead of waiting for the client
- `--resume`: skip exported notes whose Markdown is already fresh; `--skip-existing` is an alias
- `--failed-only`: retry only notes already recorded as failed in `_wiz_export_manifest.json`
- `--degraded-only`: retry only notes recorded as lossy plain-text fallbacks
- `--coedit-only`: export only collaboration notes
- `--skip-failed`: with `--resume`, skip notes already recorded as failed in the manifest
- `--skip-web-clips`: skip notes with a web clipping type or original `http(s)` URL; with `--resume`, stale exported `.md` and `.assets/` for those notes are pruned from the output directory
- `--attachments`: download collaboration-note file links and rewrite them into `.assets/`
- `--attachments-only`: update an existing export directory with collaboration body-link attachments and legacy ordinary-note attachments
- `--legacy-attachments-only`: update only legacy ordinary-note attachments in an existing export
- `--body-attachments-only`: update only collaboration body-link attachments in an existing export
- `--dry-run`: for `upgrade-legacy`, convert and report without uploading changes
- `--note-timeout-ms N`: skip one problematic note after this timeout and restart the conversion browser
- `--attachment-timeout-ms N`: per attachment/resource download timeout
- `--limit N`: export at most N notes, useful for verification
- `--only DOC_GUID`: export one note
- `--json`: print machine-readable status/export summary
- `snapshot`: diagnostic command that prints the raw local IndexedDB snapshot
- `--profile PATH`: override the WizNote profile path

## Obsidian and SiYuan Notes

The export intentionally keeps each note's resources next to the note, using a per-note `*.assets/` directory. This layout is easier to copy, archive, and migrate by subtree because a folder can be moved without losing local Markdown links.

For Obsidian, `*.assets/` folders will appear in the file explorer by default. Keep the export layout unchanged and hide these folders in Obsidian with a community plugin such as `Hide Folders` or `File Explorer++`, using a rule that matches folders ending in `.assets`.

For SiYuan, the expected import view is the Markdown document tree, not the raw resource folders. SiYuan imports local relative Markdown resources into its asset system, and `xxx.assets` is not a hidden path. Do not rename these folders to `.assets`: SiYuan's Markdown import docs note that hidden paths are not processed. Image resources should follow the normal import path; ordinary file links such as PDFs, Office files, ZIPs, and scripts still need a later sample import check before we rely on them fully.

## Data Safety

The tool copies the WizNote Electron profile to a temporary Chrome profile and reads IndexedDB from that snapshot. `status`, `snapshot`, and `export` do not modify WizNote data.

`upgrade-legacy` is intentionally different: it writes upgraded `lite/markdown` bodies back to WizNote through the authenticated server API, so those changes can sync to WizNote cloud and other clients. Run it with `--dry-run`, `--limit`, or `--only DOC_GUID` before a full batch.

Before a full export, set WizNote to download all personal and group notes, then wait for sync to finish when practical. The `status` command reports missing local note bodies and current sync settings, but `--fetch-missing` can still export many missing notes through the WizNote server.
