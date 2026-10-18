#!/usr/bin/env python3
"""Generate simple shield icons as PNG files (standard library only)."""

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "icons"

SHIELD = [(0.50, 0.055), (0.90, 0.20), (0.90, 0.51), (0.50, 0.945), (0.10, 0.51), (0.10, 0.20)]
CHECK = [(0.29, 0.52), (0.44, 0.67), (0.73, 0.34)]
TEAL = (15, 118, 110)
TEAL_DARK = (17, 94, 89)
WHITE = (255, 255, 255)


def point_in_polygon(x: float, y: float, poly) -> bool:
    inside = False
    j = len(poly) - 1
    for i, (xi, yi) in enumerate(poly):
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def dist_to_segment(px, py, ax, ay, bx, by) -> float:
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    length2 = vx * vx + vy * vy
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / length2))
    cx, cy = ax + t * vx, ay + t * vy
    return math.hypot(px - cx, py - cy)


def render(size: int, scale: int = 4) -> bytes:
    big = size * scale
    pixels = []
    for y in range(big):
        row = []
        for x in range(big):
            nx = (x + 0.5) / big
            ny = (y + 0.5) / big
            if point_in_polygon(nx, ny, SHIELD):
                # Slight inner border for definition.
                edge = 0.035
                inner = [
                    (0.5 + (px - 0.5) * (1 - edge), 0.5 + (py - 0.5) * (1 - edge))
                    for px, py in SHIELD
                ]
                color = TEAL_DARK if not point_in_polygon(nx, ny, inner) else TEAL
                # Check mark.
                thickness = 0.075
                if any(
                    dist_to_segment(nx, ny, CHECK[i][0], CHECK[i][1], CHECK[i + 1][0], CHECK[i + 1][1])
                    < thickness
                    for i in range(len(CHECK) - 1)
                ):
                    color = WHITE
                row.append((*color, 255))
            else:
                row.append((0, 0, 0, 0))
        pixels.append(row)

    # Box-downsample to the requested size.
    data = bytearray()
    for oy in range(size):
        data.append(0)
        for ox in range(size):
            r = g = b = a = 0
            for dy in range(scale):
                for dx in range(scale):
                    pr, pg, pb, pa = pixels[oy * scale + dy][ox * scale + dx]
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            if a:
                data.extend((r // a, g // a, b // a, a // (scale * scale)))
            else:
                data.extend((0, 0, 0, 0))
    return bytes(data)


def chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def write_png(path: Path, size: int) -> None:
    raw = render(size)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        write_png(ICON_DIR / f"icon{size}.png", size)
        print(f"icons/icon{size}.png")


if __name__ == "__main__":
    main()
