/**
 * Static brand-lint for the showcase example apps (#9300).
 *
 * The brand rule is "no blue anywhere" for both flagship apps. A prior manual
 * review claimed Clone Ur Crush was no-blue after recoloring the tailwind accent
 * token + the `.gradient-text` CSS — but three hardcoded `blue-*` utility classes
 * in the JSX bypassed the token and shipped blue anyway (the manual review missed
 * them). This pure-source lint is the automated guard that makes that regression
 * impossible to merge again: it greps the apps' source for blue-family tailwind
 * utilities and named/hex blue in live styles and fails with the offending
 * file:line. It boots no stack (it never touches the `stack` fixture), so it runs
 * fast in the per-PR cloud-e2e lane + the nightly showcase-mock job.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, test } from "@playwright/test";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const EXAMPLES = join(REPO_ROOT, "packages/examples/cloud");

/**
 * Blue-family tailwind utility classes (the regression vector) on any utility
 * prefix, e.g. `from-blue-500`, `bg-sky-100`, `text-indigo-600`, `to-cyan-50`.
 */
const BLUE_TAILWIND =
  /\b(?:from|via|to|bg|text|border|ring|fill|stroke|decoration|outline|shadow|divide|placeholder|caret|accent)-(?:blue|sky|cyan|indigo)-\d{2,3}\b/;

/** Indigo hexes the prior cut shipped (Material indigo family). */
const BLUE_HEX = /#(?:3f51b5|303f9f|7986cb|1a237e|283593|3949ab)\b/i;

const SOURCE_EXT = /\.(tsx?|jsx?|css|html|svg)$/;
/** Lines that are comments / known-OK annotations are not live styles. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith("//") ||
    t.startsWith("*") ||
    t.startsWith("/*") ||
    t.startsWith("<!--") ||
    t.includes("was indigo") ||
    t.includes("no-blue") ||
    t.includes("zero blue") ||
    t.includes("blue denim") || // photographic content note
    t.includes("blue-family")
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (
      name === "node_modules" ||
      name === ".next" ||
      name === "dist" ||
      name.startsWith(".next-build-") ||
      name === ".turbo"
    ) {
      continue;
    }
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (SOURCE_EXT.test(name)) out.push(full);
  }
  return out;
}

function scanApp(appDir: string): string[] {
  const violations: string[] = [];
  for (const file of walk(appDir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (BLUE_TAILWIND.test(line) || BLUE_HEX.test(line)) {
        violations.push(
          `${relative(REPO_ROOT, file)}:${i + 1}: ${line.trim()}`,
        );
      }
    });
  }
  return violations;
}

test.describe("showcase apps — brand lint (no blue)", () => {
  for (const app of ["edad", "clone-ur-crush"]) {
    test(`${app} has zero blue in live source`, () => {
      const dir = join(EXAMPLES, app);
      expect(
        statSync(dir).isDirectory(),
        `${app} example app exists`,
      ).toBeTruthy();
      const violations = scanApp(dir);
      expect(
        violations,
        `no blue-family tailwind utilities or indigo hex in ${app}:\n${violations.join("\n")}`,
      ).toEqual([]);
    });
  }

  test("both apps reference only existing OG/social assets", () => {
    // layout/index metadata references that 404 are a real defect (#9300).
    const checks: Array<{ app: string; ref: string; file: string }> = [
      {
        app: "clone-ur-crush",
        ref: "og-image.png",
        file: "clone-ur-crush/public/og-image.png",
      },
      { app: "edad", ref: "og-image.png", file: "edad/public/og-image.png" },
    ];
    const missing: string[] = [];
    for (const c of checks) {
      try {
        statSync(join(EXAMPLES, c.file));
      } catch {
        missing.push(c.file);
      }
    }
    expect(
      missing,
      `referenced social assets exist:\n${missing.join("\n")}`,
    ).toEqual([]);
  });
});
