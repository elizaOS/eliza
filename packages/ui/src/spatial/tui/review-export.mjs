/**
 * TUI review export. Renders the gallery archetypes at a few widths, runs the
 * framing linter, and writes a column-ruled text report for visual + automated
 * review. Run from the repo: `bun packages/ui/src/spatial/tui/review-export.mjs`
 */
import { writeFileSync } from "node:fs";
import React from "react";
import { GALLERY } from "../gallery.tsx";
import { analyzeFraming, columnRuler, stripAnsi } from "./framing.ts";
import { renderViewToLines } from "./index.ts";

const WIDTHS = [56, 38, 24];
let report = "";
let totalIssues = 0;
const summary = [];

for (const screen of GALLERY) {
  for (const w of WIDTHS) {
    const lines = renderViewToLines(React.createElement(screen.view), w);
    const r = analyzeFraming(lines);
    totalIssues += r.issues.length;
    if (r.issues.length)
      summary.push(`${screen.id}@${w}: ${r.issues.length} issues`);
    report += `\n========= ${screen.id} @ ${w}  (boxes=${r.boxes} uniform=${r.uniformWidth} issues=${r.issues.length}) =========\n`;
    report += `${columnRuler(w)}\n`;
    report += `${lines.map(stripAnsi).join("\n")}\n`;
    if (r.issues.length) {
      report += "ISSUES:\n";
      for (const i of r.issues) {
        report += `  [${i.kind}] row ${i.row} col ${i.col ?? "-"}: ${i.detail}\n`;
      }
    }
  }
}

writeFileSync("/tmp/tui-review.txt", report);
console.log(`wrote /tmp/tui-review.txt — total framing issues: ${totalIssues}`);
if (summary.length) console.log(summary.join("\n"));
