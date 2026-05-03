# Troubleshooting

## 1. Export is much slower than expected

The biggest factor is local cache coverage.

When note bodies and resources are already local, the exporter mostly performs local reads and gets much faster. When they are missing locally, the exporter falls back to server recovery, which is slower and less predictable.

Recommendations:

- enable WizNote's download-all-notes setting first
- keep WizNote open during migration if you still need local fallback services
- use `--fetch-missing` when waiting for normal sync is too slow

In the tested WizNote build, the exact UI path is:

- `Settings`
- `Sync Settings`
- set `Offline Personal Notes` to `All Notes`
- set `Offline Group Notes (Legacy Notes)` to `All Notes`

Those settings download note bodies for offline reading. They do not include attachments.

This is why waiting matters. A large export started before WizNote finishes local background sync will usually spend much more time in fallback recovery. WizNote's own offline sync can be slow even when it is behaving normally, so users should expect to wait patiently at this stage. `--fetch-missing` helps in that situation, but its failure rate is typically higher than exporting after local sync completes.

## 2. Collaboration resources are missing

Collaboration note resources can exist in multiple places:

- IndexedDB
- browser Cache API
- editor resource cache
- WizNote server
- original Electron profile cache on disk

This project already tries those layers in order. A note being visible in the WizNote UI does not guarantee the copied Chromium profile can see the same cache objects.

## 3. Legacy HTML conversion can be lossy

Some old ordinary notes do not survive the HTML-to-Markdown conversion path cleanly. In practice:

- the main path tries the richer editor conversion first
- fallback conversion may still succeed with lower fidelity
- some notes still need manual review

The important boundary is that this project does not treat raw HTML as the final export artifact. Normal `export` can still produce Markdown from legacy HTML notes without modifying the source notes inside WizNote.

Do not assume every legacy HTML note can be converted losslessly.

If you choose `upgrade-legacy`, that is a separate write-back operation. It converts old HTML notes into `lite/markdown` and uploads the converted result back into WizNote, so the original notes are changed.

## 4. Web-clipping notes behave differently

Old web-clipping notes do not all behave the same. Some can be exported through the normal Markdown path, while others still need fallback conversion or an explicit `upgrade-legacy` step.

Older `webnote` items may still need:

- `upgrade-legacy`
- fallback conversion
- manual spot checks

If a `webnote` succeeds, the practical result is still Markdown output rather than a raw HTML archive. Depending on the note, that may happen through direct export-side conversion or through a separate `upgrade-legacy` step.

## 5. Upgrade may fail entirely

Do not assume old notes can be upgraded successfully, either from the client UI or through exporter-side write-back. Treat `upgrade-legacy` as an optional recovery path, not as a guaranteed preparation step.

## 6. Markdown looks wrong after export

Typical causes:

- the body was wrapped by an outer `Plain Text` fence
- the first body heading duplicates the file title
- a fallback converter preserved page chrome or other non-content blocks

This repository already strips two common layout artifacts:

- a whole-body outer `Plain Text` fence
- a leading H1 identical to the note title

Some notes can still need one-off cleanup.

## 7. Resume or retry results look inconsistent

Run:

```bash
node scripts/wiz-export.js verify --out ./export --rewrite-manifest
```

This rebuilds the manifest from actual Markdown files and local assets on disk. It is the fastest way to recover after interruption or manual repairs.

## 8. Parallel retries and manifest safety

Manifest writes use a short lock only during merge/write. The heavy work runs outside the lock. This allows multiple narrow retry processes to coexist without holding the manifest for the whole export.

## 9. Missing-resource scan reports moved paths

`find-missing-local-resources.js` can report `moved` paths, which means the resource still exists but no longer sits beside the Markdown note.

You can repair that with:

```bash
node scripts/find-missing-local-resources.js ../export-wiznotes --fix-moved
```

Use `--dry-run` first if you want to preview the move list. The script writes `find-missing-local-resources.log` in the export root by default.

If the log says `ambiguous moved match`, there are multiple same-named candidates and the script will skip that case on purpose.
