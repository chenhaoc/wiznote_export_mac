# Post-Import Notes

## Obsidian

Recommended workflow:

1. Keep the exported directory structure unchanged.
2. Open the export root as a vault, or copy the exported subtree into an existing vault.
3. Keep note-local `*.assets/` directories next to each Markdown file.

Suggestions:

- If `*.assets/` folders make the file explorer noisy, hide them with an Obsidian-compatible file-explorer plugin or view setting rather than renaming them.
- Avoid aggressive automatic attachment renaming or relocation until you finish spot-checking the migrated vault.
- Spot-check a few large notes, a few collaboration notes, and a few old web-clipping notes before deleting your WizNote source data.

## SiYuan

Recommended workflow:

1. Import the Markdown tree into a notebook.
2. Keep the exported folder names and relative paths unchanged during the first import pass.
3. Treat the exported tree as the migration source of truth until validation is complete.

Suggestions:

- Do not rename `*.assets/` to hidden paths such as `.assets` before import.
- Spot-check image rendering, local file links, and a few larger notes after import.
- Pay extra attention to binary file links such as PDF, Office, ZIP, and script files, because those are the most likely to need import-side adjustment.

## General Recommendation

- Keep one immutable export snapshot as a backup until the target note app has been validated.
- Run note-level spot checks before any bulk rename, move, or cleanup inside the target app.
- If Finder birth/modified times matter to your workflow, you can sync them from note frontmatter with `python3 scripts/sync_note_file_times.py --mode conservative ../export-wiznotes`.
