#!/usr/bin/env python3
"""Download the latest uBlock Origin Lite (uBOL) Chromium build.

uBOL is the mature, MV3-native content blocker from the uBlock Origin author.
Use this when you would rather run a battle-tested extension than the local
AdBlock Mini build:

    py -3 tools/fetch_ubol.py
    # then load alternatives/ubol as an unpacked extension

Requires only the Python standard library.
"""

from __future__ import annotations

import json
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "alternatives"
API = "https://api.github.com/repos/uBlockOrigin/uBOL-home/releases/latest"


def main() -> int:
    req = urllib.request.Request(API, headers={"User-Agent": "AdBlockMini/1.0"})
    with urllib.request.urlopen(req, timeout=60) as response:
        release = json.load(response)

    tag = release["tag_name"]
    asset = next(
        (item for item in release["assets"] if "chromium" in item["name"] and item["name"].endswith(".zip")),
        None,
    )
    if not asset:
        print("No Chromium zip asset found in the latest uBOL release.", file=sys.stderr)
        return 1

    DEST.mkdir(parents=True, exist_ok=True)
    archive = DEST / asset["name"]
    print(f"uBOL {tag}: {asset['name']} ({asset['size'] / 1024 / 1024:.1f} MiB)")
    if not archive.exists():
        download = urllib.request.Request(asset["browser_download_url"], headers={"User-Agent": "AdBlockMini/1.0"})
        with urllib.request.urlopen(download, timeout=300) as response, archive.open("wb") as handle:
            handle.write(response.read())
        print(f"saved: {archive}")

    target = DEST / "ubol"
    with zipfile.ZipFile(archive) as zf:
        zf.extractall(target)
    print(f"extracted: {target}")
    print("Load unpacked: chrome://extensions -> Developer mode -> Load unpacked -> select that folder")
    return 0


if __name__ == "__main__":
    sys.exit(main())
