#!/usr/bin/env python3
"""
根据 Markdown frontmatter 里的时间字段，
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
- 默认使用 `updated` 回写文件修改时间（mtime）
- `--mode conservative` 时，优先使用 `date modified` 回写 mtime，
  缺失时再退回 `updated`
- 仅处理 `.md` 文件
- 没有可用时间字段的文件会跳过
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
FIELD_RE = re.compile(
    r'(?mi)^(created|updated|date created|date modified):\s*"?([^"\n]+)"?\s*$'
)


@dataclass
class NoteTimes:
    created: datetime | None
    updated: datetime | None
    date_created: datetime | None
    date_modified: datetime | None


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
    parser.add_argument(
        "--mode",
        choices=("standard", "conservative"),
        default="standard",
        help=(
            "standard: use updated as mtime; "
            "conservative: prefer date modified, fallback to updated."
        ),
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


def normalize_loose_seconds(raw_value: str) -> str:
    value = raw_value.strip()
    match = re.search(r"(?P<prefix>.*\d:)(?P<sec>\d+)(?P<suffix>\s*(?:[AaPp][Mm])?)$", value)
    if not match:
        return value
    seconds = int(match.group("sec"))
    if seconds <= 59:
        return value
    return f"{match.group('prefix')}59{match.group('suffix')}"


def parse_local_datetime(raw_value: str) -> datetime:
    value = normalize_loose_seconds(raw_value)
    patterns = (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y %I:%M:%S %p",
        "%Y %I:%M %p",
        "%Y %H:%M:%S",
        "%Y %H:%M",
    )
    for pattern in patterns:
        try:
            dt = datetime.strptime(value, pattern)
            return dt.astimezone()
        except ValueError:
            continue
    raise ValueError(f"Unsupported local datetime format: {raw_value}")


def extract_note_times(path: Path) -> NoteTimes:
    content = path.read_text(encoding="utf-8", errors="ignore")
    match = FRONTMATTER_RE.match(content)
    if not match:
        return NoteTimes(created=None, updated=None, date_created=None, date_modified=None)

    # Only inspect the frontmatter block at the top of the note.
    created: datetime | None = None
    updated: datetime | None = None
    date_created: datetime | None = None
    date_modified: datetime | None = None
    for field, value in FIELD_RE.findall(match.group(1)):
        normalized = field.lower()
        if normalized == "created":
            created = parse_iso_datetime(value)
        elif normalized == "updated":
            updated = parse_iso_datetime(value)
        elif normalized == "date created":
            date_created = parse_local_datetime(value)
        elif normalized == "date modified":
            date_modified = parse_local_datetime(value)
    return NoteTimes(
        created=created,
        updated=updated,
        date_created=date_created,
        date_modified=date_modified,
    )


def choose_created_time(note_times: NoteTimes) -> datetime | None:
    return note_times.date_created or note_times.created


def choose_modified_time(note_times: NoteTimes, mode: str) -> datetime | None:
    if mode == "conservative":
        return note_times.date_modified or note_times.updated
    return note_times.updated


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
            created_dt = choose_created_time(note_times)
            modified_dt = choose_modified_time(note_times, args.mode)
            if not created_dt and not modified_dt:
                skipped += 1
                continue

            created_text = created_dt.isoformat() if created_dt else "-"
            updated_text = modified_dt.isoformat() if modified_dt else "-"

            if args.dry_run:
                print(f"DRY {path}")
                print(f"  created -> {created_text}")
                print(f"  updated -> {updated_text}")
                changed += 1
                continue

            if created_dt:
                set_birth_time(path, created_dt)
            if modified_dt:
                set_modified_time(path, modified_dt)
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
