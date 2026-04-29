#!/usr/bin/env python3
"""
根据 Markdown frontmatter 里的 `created` / `updated` 字段，
回写 macOS 文件的创建时间和修改时间。

使用方式：
1. 先预览将要修改哪些文件：
   python3 scripts/sync_note_file_times.py --dry-run export-wiznotes
2. 正式处理整个导出目录：
   python3 scripts/sync_note_file_times.py export-wiznotes
3. 只处理某个子目录：
   python3 scripts/sync_note_file_times.py export-wiznotes/研究生项目
4. 正式处理时打印每个文件：
   python3 scripts/sync_note_file_times.py --verbose export-wiznotes

说明：
- `created` 用于回写 Finder 里的创建时间（birth time）
- `updated` 用于回写文件修改时间（mtime）
- 仅处理 `.md` 文件
- 没有 `created` / `updated` 的文件会跳过
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


FRONTMATTER_RE = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)
FIELD_RE = re.compile(r'(?m)^(created|updated):\s*"?([^"\n]+)"?\s*$')


@dataclass
class NoteTimes:
    created: datetime | None
    updated: datetime | None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sync macOS file birth/modified times from note frontmatter.",
        epilog=(
            "Examples:\n"
            "  python3 scripts/sync_note_file_times.py --dry-run export-wiznotes\n"
            "  python3 scripts/sync_note_file_times.py export-wiznotes/研究生项目\n"
            "  python3 scripts/sync_note_file_times.py --verbose export-wiznotes\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "paths",
        nargs="+",
        help="Markdown file or directory paths to process.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show planned changes without modifying file times.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print every changed file during non-dry-run execution.",
    )
    return parser.parse_args()


def iter_markdown_files(paths: list[str]) -> list[Path]:
    files: list[Path] = []
    for raw_path in paths:
        path = Path(raw_path)
        if path.is_file():
            if path.suffix.lower() == ".md":
                files.append(path)
            continue
        if path.is_dir():
            files.extend(sorted(path.rglob("*.md")))
    return sorted(set(files))


def parse_iso_datetime(raw_value: str) -> datetime:
    normalized = raw_value.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(normalized)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone()


def extract_note_times(path: Path) -> NoteTimes:
    content = path.read_text(encoding="utf-8", errors="ignore")
    match = FRONTMATTER_RE.match(content)
    if not match:
        return NoteTimes(created=None, updated=None)

    # Only inspect the frontmatter block at the top of the note.
    created: datetime | None = None
    updated: datetime | None = None
    for field, value in FIELD_RE.findall(match.group(1)):
        if field == "created":
            created = parse_iso_datetime(value)
        elif field == "updated":
            updated = parse_iso_datetime(value)
    return NoteTimes(created=created, updated=updated)


def set_birth_time(path: Path, dt: datetime) -> None:
    # `SetFile -d` updates the macOS birth time shown by Finder.
    subprocess.run(
        [
            "SetFile",
            "-d",
            dt.strftime("%m/%d/%Y %H:%M:%S"),
            str(path),
        ],
        check=True,
    )


def set_modified_time(path: Path, dt: datetime) -> None:
    # `touch -t` updates the filesystem modification time.
    subprocess.run(
        [
            "touch",
            "-t",
            dt.strftime("%Y%m%d%H%M.%S"),
            str(path),
        ],
        check=True,
    )


def main() -> int:
    args = parse_args()
    files = iter_markdown_files(args.paths)
    if not files:
        print("No markdown files found.", file=sys.stderr)
        return 1

    changed = 0
    skipped = 0
    failed = 0

    for path in files:
        try:
            note_times = extract_note_times(path)
            if not note_times.created and not note_times.updated:
                skipped += 1
                continue

            created_text = note_times.created.isoformat() if note_times.created else "-"
            updated_text = note_times.updated.isoformat() if note_times.updated else "-"

            if args.dry_run:
                print(f"DRY {path}")
                print(f"  created -> {created_text}")
                print(f"  updated -> {updated_text}")
                changed += 1
                continue

            if note_times.created:
                set_birth_time(path, note_times.created)
            if note_times.updated:
                set_modified_time(path, note_times.updated)
            if args.verbose:
                print(f"OK  {path}")
            changed += 1
        except Exception as exc:  # noqa: BLE001
            print(f"ERR {path}: {exc}", file=sys.stderr)
            failed += 1

    print(
        f"Summary: scanned={len(files)} changed={changed} skipped={skipped} failed={failed}",
        file=sys.stderr if failed else sys.stdout,
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
