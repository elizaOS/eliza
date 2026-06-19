/**
 * Production-view framing gate. Registers every plugin's terminal view through
 * its real `register-terminal-view.tsx`, then renders each via the terminal
 * registry and asserts the framing linter finds zero issues (uniform width,
 * closed/aligned borders, no overflow) at several widths. This exercises the
 * actual registration path and guards every converted plugin view's TUI render.
 */

import { writeFileSync } from "node:fs";
import React from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeFraming, columnRuler, stripAnsi } from "../tui/framing.ts";
import { getTerminalView, listTerminalViewIds } from "../tui/index.ts";

// Plugin view files use JSX without importing React. Depending on how vite's
// per-file tsconfig resolves the JSX runtime for these out-of-root files, they
// may be transpiled to classic `React.createElement` — make React global so the
// gate is robust to the transform either way.
(globalThis as unknown as { React: typeof React }).React = React;

// Auto-discover every plugin's terminal-view registration module.
const registerModules = import.meta.glob(
  "../../../../../plugins/*/src/**/register-terminal-view.tsx",
);

const registeredIds: string[] = [];

beforeAll(async () => {
  for (const load of Object.values(registerModules)) {
    const mod = (await load()) as Record<string, unknown>;
    const entry = Object.entries(mod).find(
      ([k, v]) => typeof v === "function" && /^register.*TerminalView$/.test(k),
    );
    if (entry) (entry[1] as () => void)();
  }
  registeredIds.push(...listTerminalViewIds().sort());
});

describe("plugin terminal views — registration + framing", () => {
  it("registers a substantial set of plugin terminal views", () => {
    // 23 converted plugins (phone + 22). Allow for shared ids; require the bulk.
    expect(registeredIds.length).toBeGreaterThanOrEqual(20);
  });

  it("exports all real views for visual review (TUI_REVIEW_OUT)", () => {
    const out = process.env.TUI_REVIEW_OUT;
    if (!out) return; // only writes when explicitly requested
    let report = "";
    for (const id of registeredIds) {
      const component = getTerminalView(id);
      if (!component) continue;
      for (const w of [56, 38]) {
        const lines = component.render(w);
        const r = analyzeFraming(lines);
        report += `\n===== ${id} @ ${w} (boxes=${r.boxes} issues=${r.issues.length}) =====\n`;
        report += `${columnRuler(w)}\n${lines.map(stripAnsi).join("\n")}\n`;
      }
    }
    writeFileSync(out, report);
  });

  for (const width of [56, 40]) {
    it(`every registered view frames cleanly @ ${width}`, () => {
      const failures: string[] = [];
      for (const id of registeredIds) {
        const component = getTerminalView(id);
        if (!component) continue;
        const report = analyzeFraming(component.render(width));
        if (!report.uniformWidth || report.issues.length) {
          failures.push(
            `${id}@${width}: uniform=${report.uniformWidth} ${report.issues
              .map((i) => `${i.kind}@${i.row}`)
              .join(",")}`,
          );
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
