/**
 * Real-plugin TUI review. Auto-discovers every plugin's register-terminal-view
 * module, invokes its registration, then renders each registered view through
 * the terminal registry at several widths and runs the framing linter. This is
 * the actual production-view review (not the gallery archetypes): it exercises
 * the real registration path AND checks framing on every plugin's default state.
 *
 *   bun packages/ui/src/spatial/tui/review-plugins.mjs
 */
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyzeFraming, columnRuler, stripAnsi } from "./framing.ts";
import { getTerminalView, listTerminalViewIds } from "./index.ts";

const repoRoot = resolve(import.meta.dirname, "../../../../..");
const pluginsDir = join(repoRoot, "plugins");

// Find every plugins/*/src/**/register-terminal-view.tsx
function findRegisterModules(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...findRegisterModules(full));
    } else if (entry === "register-terminal-view.tsx") {
      out.push(full);
    }
  }
  return out;
}

const modules = findRegisterModules(pluginsDir).sort();
let registered = 0;
for (const mod of modules) {
  try {
    const m = await import(mod);
    const fn = Object.entries(m).find(
      ([k, v]) => typeof v === "function" && /^register.*TerminalView$/.test(k),
    );
    if (fn) {
      fn[1]();
      registered += 1;
    } else {
      console.warn(`no register*TerminalView export in ${mod}`);
    }
  } catch (err) {
    console.warn(`failed to import ${mod}: ${err?.message ?? err}`);
  }
}

const ids = listTerminalViewIds().sort();
const WIDTHS = [56, 38];
let report = "";
let totalIssues = 0;
const failing = [];

for (const id of ids) {
  const component = getTerminalView(id);
  if (!component) continue;
  for (const w of WIDTHS) {
    const lines = component.render(w);
    const r = analyzeFraming(lines);
    totalIssues += r.issues.length;
    if (r.issues.length || !r.uniformWidth) failing.push(`${id}@${w}`);
    report += `\n========= ${id} @ ${w}  (boxes=${r.boxes} uniform=${r.uniformWidth} issues=${r.issues.length}) =========\n`;
    report += `${columnRuler(w)}\n`;
    report += `${lines.map(stripAnsi).join("\n")}\n`;
    for (const i of r.issues) {
      report += `  ISSUE [${i.kind}] row ${i.row} col ${i.col ?? "-"}: ${i.detail}\n`;
    }
  }
}

writeFileSync("/tmp/tui-plugins-review.txt", report);
console.log(
  `registered ${registered}/${modules.length} plugin terminal views; rendered ${ids.length} views; framing issues: ${totalIssues}`,
);
if (failing.length) console.log("NEEDS WORK:", failing.join(", "));
console.log("views:", ids.join(", "));
