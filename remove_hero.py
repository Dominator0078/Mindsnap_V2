from __future__ import annotations

import argparse
import sys
from html.parser import HTMLParser
from pathlib import Path


class HeroSectionLocator(HTMLParser):
    def __init__(self, source: str) -> None:
        super().__init__(convert_charrefs=False)
        self._source = source
        self._line_starts = [0]
        for idx, char in enumerate(source):
            if char == "\n":
                self._line_starts.append(idx + 1)
        self._stack: list[str] = []
        self._hero_depth: int | None = None
        self._hero_start: int | None = None
        self._hero_end: int | None = None
        self.errors: list[str] = []

    def _abs_index(self, line: int, col: int) -> int:
        if line <= 0 or line > len(self._line_starts):
            raise ValueError("Invalid parser position")
        return self._line_starts[line - 1] + col

    @staticmethod
    def _to_dict(attrs: list[tuple[str, str | None]]) -> dict[str, str]:
        out: dict[str, str] = {}
        for key, value in attrs:
            out[(key or "").lower()] = (value or "").strip()
        return out

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._on_tag_open(tag, attrs)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._on_tag_open(tag, attrs)
        self.handle_endtag(tag)

    def _on_tag_open(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag_lower = tag.lower()
        attrs_dict = self._to_dict(attrs)

        if tag_lower == "section":
            section_id = attrs_dict.get("id", "").lower()
            classes = {part.strip().lower() for part in attrs_dict.get("class", "").split() if part.strip()}
            is_home_hero = section_id == "home" and "hero" in classes
            if is_home_hero:
                if self._hero_start is not None:
                    self.errors.append("Multiple <section id='home' class='... hero ...'> blocks found.")
                else:
                    line, col = self.getpos()
                    self._hero_start = self._abs_index(line, col)
                    self._hero_depth = len(self._stack)

        self._stack.append(tag_lower)

    def handle_endtag(self, tag: str) -> None:
        if not self._stack:
            return

        tag_lower = tag.lower()
        self._stack.pop()

        if self._hero_start is not None and self._hero_end is None and tag_lower == "section":
            if self._hero_depth is not None and len(self._stack) == self._hero_depth:
                line, col = self.getpos()
                close_token = "</section>"
                start = self._abs_index(line, col)
                end = start + len(close_token)
                if self._source[start:end].lower() != close_token:
                    end = self._source.lower().find(close_token, start)
                    if end == -1:
                        self.errors.append("Could not determine closing tag for hero section.")
                        return
                    end += len(close_token)
                self._hero_end = end


def remove_hero_section(file_path: Path, dry_run: bool) -> int:
    if not file_path.exists():
        print(f"Error: file not found: {file_path}", file=sys.stderr)
        return 2

    source = file_path.read_text(encoding="utf-8")
    parser = HeroSectionLocator(source)
    parser.feed(source)

    if parser.errors:
        print(f"Error: {parser.errors[0]}", file=sys.stderr)
        return 2

    if parser._hero_start is None or parser._hero_end is None:
        print("Error: hero section not found or not confidently parsed. No changes made.", file=sys.stderr)
        return 2

    removed = source[parser._hero_start : parser._hero_end]
    result = source[: parser._hero_start] + source[parser._hero_end :]

    if dry_run:
        preview = removed.strip().splitlines()
        preview_text = preview[0][:120] if preview else ""
        print(f"[dry-run] Would remove {len(removed)} chars from {file_path.name}")
        print(f"[dry-run] First line: {preview_text}")
        return 0

    file_path.write_text(result, encoding="utf-8")
    print(f"Removed hero section from {file_path}")
    return 0


def main() -> int:
    here = Path(__file__).resolve().parent
    default_file = here / "mind_snap.html"

    arg_parser = argparse.ArgumentParser(description="Remove the home hero section from mind_snap.html safely.")
    arg_parser.add_argument("--file", type=Path, default=default_file, help="Target HTML file path.")
    arg_parser.add_argument("--dry-run", action="store_true", help="Print planned removal without writing file.")
    args = arg_parser.parse_args()

    return remove_hero_section(args.file, dry_run=args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
