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
5. 只处理最近 30 天内本地改过的 Markdown：
   python3 scripts/sync_note_file_times.py --mode conservative --modified-within-days 30 export-wiznotes

说明：
- `created` 用于回写 Finder 里的创建时间（birth time）
- 默认使用 `updated` 回写文件修改时间（mtime）
- `--mode conservative` 时，优先使用 `date modified` 回写 mtime，
  缺失时再退回 `updated`
- `--modified-within-days` 基于当前本地文件 mtime 预筛选，
  用来避开全量扫描时的正文解析与时间回写
- 仅处理 `.md` 文件
- 没有可用时间字段的文件会跳过
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


FIELD_RE = re.compile(
    r'(?mi)^(created|updated|date created|date modified):\s*"?([^"\n]+)"?\s*$'
)


@dataclass
class NoteTimes:
    created: datetime | None
    updated: datetime | None
    date_created: datetime | None
    date_modified: datetime | None


def positive_days(raw_value: str) -> float:
    try:
        value = float(raw_value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"Invalid day count: {raw_value}") from exc
    if value <= 0:
        raise argparse.ArgumentTypeError("Day count must be greater than 0.")
    return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sync macOS file birth/modified times from note frontmatter.",
        epilog=(
            "Examples:\n"
            "  python3 scripts/sync_note_file_times.py --dry-run export-wiznotes\n"
            "  python3 scripts/sync_note_file_times.py export-wiznotes/研究生项目\n"
            "  python3 scripts/sync_note_file_times.py --verbose export-wiznotes\n"
            "  python3 scripts/sync_note_file_times.py --mode conservative --modified-within-days 30 export-wiznotes\n"
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
    parser.add_argument(
        "--modified-within-days",
        type=positive_days,
        metavar="DAYS",
        help=(
            "Only inspect files whose current local mtime is within the last N days. "
            "This pre-filter uses the existing filesystem mtime before syncing."
        ),
    )
    return parser.parse_args()


def iter_markdown_files(paths: list[str]) -> list[Path]:
    files: set[Path] = set()
    for raw_path in paths:
        path = Path(raw_path)
        if path.is_file():
            if path.suffix.lower() == ".md":
                files.add(path)
            continue
        if path.is_dir():
            files.update(path.rglob("*.md"))
    return sorted(files)


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


def read_frontmatter_block(path: Path) -> str | None:
    total_chars = 0
    frontmatter_lines: list[str] = []
    with path.open("r", encoding="utf-8", errors="ignore") as handle:
        first_line = handle.readline()
        if first_line.strip() != "---":
            return None
        total_chars += len(first_line)
        for line in handle:
            total_chars += len(line)
            if line.strip() == "---":
                return "".join(frontmatter_lines)
            frontmatter_lines.append(line)
            if total_chars >= 64 * 1024:
                break
    return None


def extract_note_times(path: Path) -> NoteTimes:
    frontmatter = read_frontmatter_block(path)
    if not frontmatter:
        return NoteTimes(created=None, updated=None, date_created=None, date_modified=None)

    # Only inspect the frontmatter block at the top of the note.
    created: datetime | None = None
    updated: datetime | None = None
    date_created: datetime | None = None
    date_modified: datetime | None = None
    for field, value in FIELD_RE.findall(frontmatter):
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


def same_filesystem_second(current_timestamp: float | None, target_dt: datetime | None) -> bool:
    if current_timestamp is None or target_dt is None:
        return False
    return int(current_timestamp) == int(target_dt.timestamp())


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


def set_modified_time(path: Path, dt: datetime, atime_ns: int) -> None:
    # `os.utime` avoids spawning `touch` for every file.
    target_mtime_ns = int(dt.timestamp()) * 1_000_000_000
    os.utime(path, ns=(atime_ns, target_mtime_ns))


def main() -> int:
    args = parse_args()
    files = iter_markdown_files(args.paths)
    if not files:
        print("No markdown files found.", file=sys.stderr)
        return 1

    changed = 0
    age_filtered = 0
    already_synced = 0
    skipped = 0
    failed = 0
    modified_since_ts = None
    if args.modified_within_days is not None:
        modified_since_ts = time.time() - (args.modified_within_days * 24 * 60 * 60)

    for path in files:
        try:
            current_stat = path.stat()
            if modified_since_ts is not None and current_stat.st_mtime < modified_since_ts:
                age_filtered += 1
                continue

            note_times = extract_note_times(path)
            created_dt = choose_created_time(note_times)
            modified_dt = choose_modified_time(note_times, args.mode)
            if not created_dt and not modified_dt:
                skipped += 1
                continue

            needs_created = created_dt is not None and not same_filesystem_second(
                getattr(current_stat, "st_birthtime", None), created_dt
            )
            needs_modified = modified_dt is not None and not same_filesystem_second(
                current_stat.st_mtime, modified_dt
            )
            if not needs_created and not needs_modified:
                already_synced += 1
                continue

            if args.dry_run:
                print(f"DRY {path}")
                if needs_created and created_dt is not None:
                    print(f"  created -> {created_dt.isoformat()}")
                if needs_modified and modified_dt is not None:
                    print(f"  updated -> {modified_dt.isoformat()}")
                changed += 1
                continue

            if needs_created and created_dt is not None:
                set_birth_time(path, created_dt)
            if needs_modified and modified_dt is not None:
                set_modified_time(path, modified_dt, current_stat.st_atime_ns)
            if args.verbose:
                print(f"OK  {path}")
            changed += 1
        except Exception as exc:  # noqa: BLE001
            print(f"ERR {path}: {exc}", file=sys.stderr)
            failed += 1

    print(
        (
            "Summary: "
            f"scanned={len(files)} "
            f"age_filtered={age_filtered} "
            f"changed={changed} "
            f"already_synced={already_synced} "
            f"skipped={skipped} "
            f"failed={failed}"
        ),
        file=sys.stderr if failed else sys.stdout,
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
