#!/usr/bin/env python3
"""Build a GitHub Pages copy with clean directory URLs, without editing sources.

Source HTML files remain untouched. For each HTML page except index.html and
pject.html, the deployment output includes both the original .html file and a
clean /Page/ route backed by Page/index.html. pject.html is copied untouched.
"""
from __future__ import annotations

import re
import shutil
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path.cwd()
OUT = ROOT / "_site"
EXCLUDED_DIRS = {".git", ".github", "node_modules", "_site", "scripts"}
EXCLUDED_FILES = {"README.md"}


def copy_source_tree() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    for item in ROOT.iterdir():
        if item.name in EXCLUDED_DIRS or item.name in EXCLUDED_FILES:
            continue
        if item.is_dir():
            shutil.copytree(item, OUT / item.name)
        elif item.is_file():
            shutil.copy2(item, OUT / item.name)


def route_for(filename: str) -> str:
    return "/" if filename.lower() == "index.html" else f"/{filename[:-5]}/"


def add_base(source: str) -> str:
    """Insert a root base URL without reserializing or otherwise altering HTML."""
    if re.search(r"<base\b", source, flags=re.I):
        return source
    updated, count = re.subn(
        r"(<head\b[^>]*>)",
        lambda m: m.group(1) + '<base href="/">',
        source,
        count=1,
        flags=re.I,
    )
    # Do not guess where to insert it if the document has no head element.
    return updated if count else source


def rewrite_links(source: str, page_name: str, known_pages: set[str], clean_copy: bool) -> str:
    # Only rewrite actual HTML URL attributes; do not touch scripts, CSS, or text.
    attr_re = re.compile(r'''(?P<prefix>\b(?:href|action|formaction)\s*=\s*)(?P<q>["'])(?P<url>.*?)(?P=q)''', re.I | re.S)
    current_route = route_for(page_name)

    def replace(match: re.Match[str]) -> str:
        url = match.group("url")
        if not url or url.startswith(("//", "#")):
            if clean_copy and url.startswith("#"):
                url = current_route + url
                return f'{match.group("prefix")}{match.group("q")}{url}{match.group("q")}'
            return match.group(0)
        parts = urlsplit(url)
        path = parts.path
        if not path or path.startswith("/") or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", path):
            return match.group(0)
        leaf = path.rsplit("/", 1)[-1]
        # pject.html is explicitly excluded from URL conversion.
        if leaf.lower() == "pject.html":
            return match.group(0)
        match_page = next((p for p in known_pages if p.lower() == leaf.lower()), None)
        if match_page is None:
            return match.group(0)
        # Only rewrite when the target is a known HTML page in this repository.
        target_route = route_for(match_page)
        if clean_copy and match_page.lower() == page_name.lower() and parts.fragment:
            new_path = target_route
        else:
            new_path = target_route
        new_url = urlunsplit(("", "", new_path, parts.query, parts.fragment))
        return f'{match.group("prefix")}{match.group("q")}{new_url}{match.group("q")}'

    return attr_re.sub(replace, source)


def main() -> None:
    copy_source_tree()
    known_pages = {
        p.name for p in ROOT.glob("*.html")
        if p.name.lower() != "pject.html"
    }

    # Rewrite only the deployed copies of root HTML files. Source files are never edited.
    for page_name in sorted(known_pages):
        out_file = OUT / page_name
        if not out_file.exists():
            continue
        source = out_file.read_text(encoding="utf-8", errors="replace")
        out_file.write_text(rewrite_links(source, page_name, known_pages, clean_copy=False), encoding="utf-8")

        if page_name.lower() == "index.html":
            continue
        clean_dir = OUT / page_name[:-5]
        clean_dir.mkdir(parents=True, exist_ok=True)
        clean_html = rewrite_links(source, page_name, known_pages, clean_copy=True)
        clean_html = add_base(clean_html)
        (clean_dir / "index.html").write_text(clean_html, encoding="utf-8")

    # Ensure pject.html remains byte-for-byte identical in the deployment copy.
    source_pject = ROOT / "pject.html"
    output_pject = OUT / "pject.html"
    if source_pject.exists() and output_pject.exists():
        if source_pject.read_bytes() != output_pject.read_bytes():
            raise SystemExit("Safety check failed: pject.html changed in deployment output")

    print(f"Built clean URL deployment in {OUT}")
    print(f"Generated {sum(1 for p in OUT.iterdir() if p.is_dir() and p.name not in EXCLUDED_DIRS)} top-level directories, including clean page routes.")
    print("Source HTML files were not modified. pject.html was preserved unchanged.")


if __name__ == "__main__":
    main()
