/**
 * Source-scanning gate banning backdrop-filter/backdrop-blur app-wide — the
 * glassmorphic blur is the biggest GPU/battery cost (#9141). Reads the src tree,
 * no runtime.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #9141 (battery): backdrop-filter — the glassmorphic blur (backdrop-blur /
// backdrop-saturate / backdrop-brightness) — forces the GPU to continuously
// re-sample the backdrop, EVEN on static elements, and re-rasterize per frame on
// anything that moves (the dragged chat sheet, scrolling surfaces). It is the
// single biggest GPU/battery cost in the UI and was removed app-wide. This gate
// fails the build if any backdrop-filter creeps back, so the battery win can't
// silently regress. (To intentionally reintroduce one, you'd remove it here with
// a justification — but the product decision is no blur.)

const SOURCE_ROOTS = [
  {
    label: "packages/ui/src",
    root: import.meta.dirname,
  },
  {
    label: "packages/app/src",
    root: join(import.meta.dirname, "../../app/src"),
  },
] as const;

// Match the Tailwind blur utilities, their arbitrary forms, the `supports-`
// modifier, and the raw CSS / inline-style property spellings.
const BACKDROP_FILTER =
  /backdrop-blur|backdrop-saturate|backdrop-brightness|backdrop-contrast|backdrop-filter|backdropFilter|WebkitBackdropFilter|supports-\[backdrop-filter\]/;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    // __e2e__ holds generated/bundled HTML+CSS fixtures (vendored blur in the
    // framer-motion/tailwind bundle), not authored UI — not subject to the gate.
    if (name === "node_modules" || name === "dist" || name === "__e2e__") {
      continue;
    }
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (
      /\.(tsx?|css)$/.test(name) &&
      !name.includes(".test.") &&
      !name.includes(".spec.")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("no backdrop-blur gate (#9141, battery)", () => {
  it("no backdrop-filter / backdrop-blur survives anywhere in authored app UI source", () => {
    const offenders: string[] = [];
    for (const { label, root } of SOURCE_ROOTS) {
      if (!existsSync(root)) continue;
      for (const file of collectSourceFiles(root)) {
        if (BACKDROP_FILTER.test(readFileSync(file, "utf8"))) {
          offenders.push(
            `${label}/${file.slice(root.length + 1).replace(/\\/g, "/")}`,
          );
        }
      }
    }
    expect(
      offenders,
      `backdrop-filter must stay removed for battery; found in: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});
