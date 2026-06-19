#!/usr/bin/env python3
"""Capture sequential screenshots of a webpage using Playwright.

Usage:
    python take_recording.py [URL] [--frames N] [--interval S]
        [--width W] [--height H] [--output-dir DIR]
        [--wait-before S] [--auto-click SELECTOR]

Defaults:
    URL            file:///workspace/output.html
    --frames       10
    --interval     0.5
    --width        1080
    --height       720
    --output-dir   /workspace/grading_frames/
    --wait-before  2
"""

import argparse
import json
import os
import sys
import time


def main():
    parser = argparse.ArgumentParser(description="Capture webpage screenshots")
    parser.add_argument("url", nargs="?", default="file:///workspace/output.html")
    parser.add_argument("--frames", type=int, default=10)
    parser.add_argument("--interval", type=float, default=0.5)
    parser.add_argument("--width", type=int, default=1080)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--output-dir", default="/workspace/grading_frames/")
    parser.add_argument("--wait-before", type=float, default=2.0)
    parser.add_argument("--auto-click", default=None, help="CSS selector to click before recording")
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(json.dumps({"ok": False, "error": "playwright not installed"}))
        sys.exit(1)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": args.width, "height": args.height})

            page.goto(args.url, wait_until="networkidle", timeout=30000)

            if args.auto_click:
                try:
                    page.click(args.auto_click, timeout=5000)
                except Exception:
                    pass  # button may not exist

            time.sleep(args.wait_before)

            for i in range(args.frames):
                path = os.path.join(args.output_dir, f"frame_{i:03d}.png")
                page.screenshot(path=path, full_page=False)
                if i < args.frames - 1:
                    time.sleep(args.interval)

            browser.close()

        print(json.dumps({"ok": True, "frames": args.frames, "output_dir": args.output_dir}))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
