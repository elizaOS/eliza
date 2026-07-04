/**
 * Source-scanning gate enforcing chromeless home/dashboard widgets (#10708):
 * widgets render directly, no card chrome. Reads the src tree, no runtime.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #10708 (chromeless widgets): home/dashboard widgets render directly on the
// wallpaper — no card chrome. The distinctive "glass card" signature is the
// TRIAD of a corner radius + a border + a translucent background fill on one
// container className (e.g. the old `rounded-xl border border-white/12
// bg-black/55`). Legitimate inner content — icon tiles (`rounded-lg
// bg-white/10`), status dots/pills (`rounded-full`), inner rows (`rounded-sm
// border border-border`) — never combines all three, so gating the triad
// catches a re-introduced card container without false-flagging content. This
// mirrors `no-backdrop-blur-gate.test.ts` so the chromeless decision can't
// silently regress.

const WIDGET_ROOTS = [
  {
    label: "packages/ui/src/components/chat/widgets",
    root: join(import.meta.dirname, "components/chat/widgets"),
  },
  {
    label: "packages/ui/src/widgets",
    root: join(import.meta.dirname, "widgets"),
  },
] as const;

const RADIUS = /\brounded-(?:sm|md|lg|xl|2xl|3xl|\[[^\]]+\])\b/; // not rounded-full (pills/dots)
const BORDER = /\bborder\s+border-[a-z0-9/[\]-]+/; // an explicit colored border
const BG_FILL =
  /\bbg-(?:black|white|bg-accent|accent|danger|warn|success)\/[0-9]+/; // translucent fill

function collectFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    // Bundled/generated e2e fixtures are not authored widget UI.
    if (name === "node_modules" || name === "dist" || name === "__e2e__") {
      continue;
    }
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectFiles(full, out);
    } else if (
      /\.tsx?$/.test(name) &&
      !name.includes(".test.") &&
      !name.includes(".stories.")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("no widget-chrome gate (#10708, chromeless widgets)", () => {
  it("no widget container reintroduces the glass-card triad (radius + border + translucent fill)", () => {
    const offenders: string[] = [];
    for (const { label, root } of WIDGET_ROOTS) {
      for (const file of collectFiles(root)) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (RADIUS.test(line) && BORDER.test(line) && BG_FILL.test(line)) {
            offenders.push(
              `${label}/${file.slice(root.length + 1).replace(/\\/g, "/")}:${i + 1}`,
            );
          }
        });
      }
    }
    expect(
      offenders,
      `Widget containers must be chromeless (#10708) — these re-introduce the ` +
        `glass-card triad (rounded + border + translucent bg on one element). ` +
        `Separate widgets by whitespace, not card chrome:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
