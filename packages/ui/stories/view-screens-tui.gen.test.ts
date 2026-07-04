/**
 * TUI screenshot generator for every registered plugin spatial view.
 *
 * Drives the SAME registration path the parity gate uses — an `import.meta.glob`
 * of every `register-terminal-view.tsx`, run through vite's transform — so it
 * covers ALL registered ids. Going through vite (never a raw Bun import) is
 * deliberate: Bun's loader can't parse the `as`-cast syntax some of these files
 * use, so a raw import would silently drop them. For each id it renders the
 * authored view to terminal lines at two widths and writes a plain-text
 * "screenshot" to `stories/__screens__/tui/<id>.txt` for human review.
 *
 * Not part of the default suite (it lives outside the `src`/`__tests__` include
 * globs). Run it explicitly via `bun run test:view-screens` /
 * `view-screens-tui.config.ts`, which writes the artifacts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { beforeAll, describe, expect, it } from "vitest";
import {
  analyzeFraming,
  columnRuler,
  stripAnsi,
} from "../src/spatial/tui/framing.ts";
import {
  getSpatialViewThunk,
  listTerminalViewIds,
  renderViewToLines,
} from "../src/spatial/tui/index.ts";

(globalThis as unknown as { React: typeof React }).React = React;

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "__screens__/tui");

const registerModules = import.meta.glob(
  "../../../plugins/*/src/**/register-terminal-view.tsx",
);

const ids: string[] = [];

beforeAll(async () => {
  mkdirSync(outDir, { recursive: true });
  for (const load of Object.values(registerModules)) {
    const mod = (await load()) as Record<string, unknown>;
    const entry = Object.entries(mod).find(
      ([k, v]) => typeof v === "function" && /^register.*TerminalView$/.test(k),
    );
    if (entry) (entry[1] as () => void)();
  }
  ids.push(...listTerminalViewIds().sort());
});

const WIDTHS = [56, 40];

describe("tui screenshots — every registered view", () => {
  it("writes a terminal-render .txt per registered id", () => {
    expect(ids.length).toBeGreaterThanOrEqual(30);

    const captured: string[] = [];
    const skipped: string[] = [];

    for (const id of ids) {
      const thunk = getSpatialViewThunk(id);
      if (!thunk) {
        skipped.push(`${id} (no authored thunk)`);
        continue;
      }
      let body = `# TUI render — ${id}\n`;
      let ok = true;
      for (const width of WIDTHS) {
        try {
          const lines = renderViewToLines(thunk(), width);
          const report = analyzeFraming(lines);
          body += `\n===== ${id} @ ${width} cols  (boxes=${report.boxes} uniform=${report.uniformWidth} issues=${report.issues.length}) =====\n`;
          body += `${columnRuler(width)}\n`;
          body += `${lines.map(stripAnsi).join("\n")}\n`;
        } catch (err) {
          ok = false;
          body += `\n===== ${id} @ ${width} cols — RENDER FAILED =====\n${(err as Error)?.message ?? err}\n`;
        }
      }
      writeFileSync(join(outDir, `${id}.txt`), body);
      if (ok) captured.push(id);
      else skipped.push(`${id} (render error)`);
    }

    // Machine-readable manifest so the contact sheet + reviewers know exactly
    // what was captured vs skipped (no silent truncation).
    writeFileSync(
      join(outDir, "manifest.json"),
      JSON.stringify({ captured, skipped }, null, 2),
    );

    // Every registered id with a thunk must have produced a render.
    expect(skipped).toEqual([]);
  });
});
