/**
 * Render every gallery screen to real terminal lines (the TUI is a Node
 * renderer) and emit JSON the browser gallery displays as ANSI-coloured HTML.
 * Lives next to gallery.tsx so `react` resolves. Run from the repo root:
 *
 *   bun packages/ui/src/spatial/gallery-tui-gen.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { GALLERY } from "./gallery.tsx";
import { renderViewToLines } from "./tui/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WIDTHS = [54, 30];

const out = {};
for (const screen of GALLERY) {
  out[screen.id] = {};
  for (const width of WIDTHS) {
    out[screen.id][width] = renderViewToLines(
      React.createElement(screen.view),
      width,
    );
  }
}

const target = resolve(here, "../../stories/spatial/spatial-gallery-tui.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(out, null, 0));
console.log(`wrote ${Object.keys(out).length} screens -> ${target}`);
