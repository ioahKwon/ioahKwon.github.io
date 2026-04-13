#!/usr/bin/env python3
"""
build_photos.py
---------------
Scans image/photography/ for any image files and writes a manifest.json
that the photography page reads at load time.

Run this whenever you add or remove photos:

    python3 build_photos.py

GitHub Pages will serve manifest.json statically — no server changes needed.
"""
import os
import re
import json
from datetime import datetime

PHOTO_DIR = os.path.join(os.path.dirname(__file__), "image", "photography")
MANIFEST_PATH = os.path.join(PHOTO_DIR, "manifest.json")
EXTS = (".jpeg", ".jpg", ".png", ".webp", ".gif")


def natural_key(s: str):
    """Sort numerically: 2.jpeg comes before 10.jpeg."""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def build():
    if not os.path.isdir(PHOTO_DIR):
        raise SystemExit(f"[build_photos] folder not found: {PHOTO_DIR}")

    files = [
        f for f in os.listdir(PHOTO_DIR)
        if f.lower().endswith(EXTS) and not f.startswith(".")
    ]
    files.sort(key=natural_key)

    manifest = {
        "photos": files,
        "count": len(files),
        "updated": datetime.now().isoformat(timespec="seconds"),
    }

    with open(MANIFEST_PATH, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"[build_photos] wrote {len(files)} entries → {MANIFEST_PATH}")


if __name__ == "__main__":
    build()
