# WizNote Markdown Export

Two-stage exporter for migrating WizNote desktop notes to Obsidian or SiYuan.

Stage 1 exports:

- folder tree as directories
- note body as Markdown
- images/resources referenced by note body into per-note `.assets` folders
- export manifest with skipped notes, missing resources, and attachment metadata counts

WizNote's "download all notes" setting helps before a full export, but it should be understood as "download all note bodies". Attachments are separate objects and are not included in that offline setting. Body images/resources are mixed: some are already local, some are in the editor resource cache, and some need to be downloaded from WizNote's resource server during export.

For legacy ordinary notes, keep the WizNote desktop app running and use `--fetch-missing`. The exporter first asks the local WizNote view server for the rendered note HTML, then converts it to Markdown without clicking through the UI. This also supports notes that were upgraded with the title-left "upgrade to realtime Markdown" button: those become `lite/markdown` notes, and the exporter extracts the Markdown source from the local view page.

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

This bypass does not write anything back into the WizNote client database. It is intended to speed up migration for notes whose bodies have not arrived locally yet. For legacy ordinary notes and `lite/markdown` notes, keep the real WizNote desktop app open because the exporter uses its local view server as the most reliable source.
If the richer editor converter hangs on a complex legacy HTML note, the exporter restarts its temporary browser and retries that note with a simpler HTML converter.

Resume an interrupted export and only process notes that are missing or stale:

```bash
node scripts/wiz-export.js export --out ./export --fetch-missing --attachments --resume
```

Resume mode first uses the existing manifest, then falls back to the target Markdown frontmatter. A note is skipped only when the target `.md` exists, `wiznote_doc_guid` matches, and the exported `updated` timestamp is not older than the note's current modified time. If the frontmatter is missing, it falls back to file mtime. When combined with `--limit`, the limit applies after fresh notes are skipped, so it processes the next N unfinished notes.

Export only collaboration notes and skip legacy HTML notes:

```bash
node scripts/wiz-export.js export --out ./export-coedit --coedit-only --attachments
```

Add attachments to an existing collaboration-note export without reconverting note bodies:

```bash
node scripts/wiz-export.js export --out ./export-coedit --attachments-only
```

If WizNote is still syncing and you want to export only notes that already have local bodies:

```bash
node scripts/wiz-export.js export --out ./export --allow-partial
```

Useful options:

- `--wait`: wait until local note bodies look complete before exporting
- `--fetch-missing`: download/sync missing note bodies during export instead of waiting for the client
- `--resume`: skip exported notes whose Markdown is already fresh; `--skip-existing` is an alias
- `--coedit-only`: export only collaboration notes
- `--attachments`: download collaboration-note file links and rewrite them into `.assets/`
- `--attachments-only`: update an existing export directory with collaboration attachments only
- `--note-timeout-ms N`: skip one problematic note after this timeout and restart the conversion browser
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

The tool copies the WizNote Electron profile to a temporary Chrome profile and reads IndexedDB from that snapshot. It does not modify WizNote data.

Before a full export, set WizNote to download all personal and group notes, then wait for sync to finish when practical. The `status` command reports missing local note bodies and current sync settings, but `--fetch-missing` can still export many missing legacy ordinary notes through the running local client.
