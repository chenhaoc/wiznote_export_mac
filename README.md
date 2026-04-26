# WizNote Markdown Export

Two-stage exporter for migrating WizNote desktop notes to Obsidian or SiYuan.

Stage 1 exports:

- folder tree as directories
- note body as Markdown
- images/resources referenced by note body into per-note `.assets` folders
- export manifest with skipped notes, missing resources, and attachment metadata counts

WizNote's "download all notes" setting is still required before a full export, but it should be understood as "download all note bodies". Attachments are separate objects and are not included in that offline setting. Body images/resources are mixed: some are already local, some are in the editor resource cache, and some need to be downloaded from WizNote's resource server during export.

Stage 2 is intentionally left incremental: attachment download and Markdown attachment links will build on the manifest and note-path mapping produced by stage 1.

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

This bypass does not write anything back into the WizNote client database. It is intended to speed up migration for notes whose bodies have not arrived locally yet.
If the richer editor converter hangs on a complex legacy HTML note, the exporter restarts its temporary browser and retries that note with a simpler HTML converter.

Export only collaboration notes and skip legacy HTML notes:

```bash
node scripts/wiz-export.js export --out ./export-coedit --coedit-only
```

If WizNote is still syncing and you want to export only notes that already have local bodies:

```bash
node scripts/wiz-export.js export --out ./export --allow-partial
```

Useful options:

- `--wait`: wait until local note bodies look complete before exporting
- `--fetch-missing`: download/sync missing note bodies during export instead of waiting for the client
- `--coedit-only`: export only collaboration notes
- `--note-timeout-ms N`: skip one problematic note after this timeout and restart the conversion browser
- `--limit N`: export at most N notes, useful for verification
- `--only DOC_GUID`: export one note
- `--json`: print machine-readable status/export summary
- `--profile PATH`: override the WizNote profile path

## Data Safety

The tool copies the WizNote Electron profile to a temporary Chrome profile and reads IndexedDB from that snapshot. It does not modify WizNote data.

Before a full export, set WizNote to download all personal and group notes, then wait for sync to finish. The `status` command reports missing local note bodies and current sync settings.
