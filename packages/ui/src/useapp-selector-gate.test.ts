/**
 * Source-scanning gate steering callers off the monolithic useApp() toward
 * narrow selectors so a single field change doesn't re-render everything (#9141).
 * Reads the src tree, no runtime.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #9141 gap #2 — `useApp()` returns the whole monolithic AppContext value, so a
// component/hook that calls it re-renders on ANY of the ~300 context fields
// changing. The migration replaces it with field-level `useAppSelector` /
// `useAppSelectorShallow` selectors that only re-render on the slices actually
// read. This gate locks that progress in: it fails the build if a NEW `useApp()`
// call site appears outside the deliberately-allowed list.
//
// To intentionally keep/add a `useApp()` site: it must have a real reason (e.g.
// a defensive `as ... | undefined` boundary that genuinely needs the whole value)
// and be added here with that why. Prefer a selector.
const ALLOWED = new Set<string>([
  // The hook definition itself — the only remaining `useApp()` site. Every
  // consumer (including ChatView's main view and its inbox-subview boundary) is
  // now on a granular `useAppSelector` / `useAppSelectorShallow` selector.
  "state/useApp.ts",
]);

const SRC_ROOT = import.meta.dirname;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (
      /\.tsx?$/.test(name) &&
      !name.includes(".test.") &&
      !name.includes(".spec.") &&
      !name.includes(".stories.")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** A real `useApp()` call — not a jsdoc/comment mention, not the definition. */
function callsUseApp(text: string): boolean {
  return text.split("\n").some((line) => {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("*") ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*")
    ) {
      return false;
    }
    if (trimmed.includes("function useApp(")) return false;
    return /\buseApp\(\)/.test(line);
  });
}

describe("useApp() → useAppSelector migration gate (#9141)", () => {
  it("only the allow-listed sites still call the monolithic useApp()", () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      if (callsUseApp(readFileSync(file, "utf8"))) {
        const rel = file.slice(SRC_ROOT.length + 1).replace(/\\/g, "/");
        if (!ALLOWED.has(rel)) offenders.push(rel);
      }
    }
    expect(
      offenders,
      `new useApp() call sites (migrate to useAppSelector): ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("every allow-listed file still exists and still calls useApp() (no stale entries)", () => {
    for (const rel of ALLOWED) {
      const text = readFileSync(join(SRC_ROOT, rel), "utf8");
      expect(/\buseApp\(\)/.test(text), `stale allow-list entry: ${rel}`).toBe(
        true,
      );
    }
  });
});
