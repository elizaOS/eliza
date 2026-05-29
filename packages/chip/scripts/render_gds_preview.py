#!/usr/bin/env python3
"""Render a GDS layout PNG from inside KLayout's Python runtime."""

from __future__ import annotations

import os
import sys

import pya


def env(name: str, default: str = "") -> str:
    value = os.environ.get(name, default)
    if not value:
        raise SystemExit(f"missing required environment variable: {name}")
    return value


def main() -> int:
    gds = env("ELIZA_GDS_INPUT")
    out = env("ELIZA_GDS_OUTPUT")
    width = int(os.environ.get("ELIZA_GDS_WIDTH", "4096"))
    height = int(os.environ.get("ELIZA_GDS_HEIGHT", "4096"))
    lyp = os.environ.get("ELIZA_GDS_LYP", "")

    app = pya.Application.instance()
    main_window = app.main_window()
    if main_window is None:
        view = pya.LayoutView()
        view.load_layout(gds, True)
    else:
        main_window.load_layout(gds, 0)
        view = main_window.current_view()
        if view is None:
            raise SystemExit("KLayout did not create a layout view")
    if lyp:
        view.load_layer_props(lyp)
    view.max_hier()
    view.zoom_fit()
    view.save_image(out, width, height)
    print(f"wrote {out}")
    app.exit(0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
