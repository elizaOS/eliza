/**
 * Source-scanning gate banning stray focus-ring styles that violate the design
 * system while pinning the shell pill's sole keyboard focus indicator. Reads
 * the src tree, no runtime.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = import.meta.dirname;

const APPROVED_FOCUS_UTILITIES = new Map([
  [
    "components/shell/HomePill.tsx",
    new Set([
      "focus-visible:bg-transparent",
      "focus-visible:ring-2",
      "focus-visible:ring-white/70",
      "focus-visible:ring-offset-2",
      "focus-visible:ring-offset-transparent",
    ]),
  ],
]);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
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

function isFocusUtility(token: string): boolean {
  if (
    token.startsWith("--") ||
    token.startsWith("lint/") ||
    token === "focus:"
  ) {
    return false;
  }
  return (
    token.includes("focus:") ||
    token.includes("focus-visible:") ||
    token.includes("focus-within:") ||
    /\[[^\]\s]*:focus(?:-visible|-within)?[^\]\s]*\]:/.test(token)
  );
}

function isRingUtility(token: string): boolean {
  return /(?:^|!|:|\[)ring-/.test(token);
}

describe("no focus/ring utility gate", () => {
  it("rejects unapproved focus/ring utilities and pins the shell pill indicator", () => {
    const offenders: string[] = [];
    const approvedCounts = new Map<string, number>();
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const relative = file.slice(SRC_ROOT.length + 1).replace(/\\/g, "/");
      const lines = readFileSync(file, "utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const tokens = lines[index].match(/[^\s"'`{}<>]+/g) ?? [];
        const badTokens = tokens.filter(
          (token) => isFocusUtility(token) || isRingUtility(token),
        );
        for (const token of badTokens) {
          if (APPROVED_FOCUS_UTILITIES.get(relative)?.has(token)) {
            const key = `${relative}:${token}`;
            approvedCounts.set(key, (approvedCounts.get(key) ?? 0) + 1);
          } else {
            offenders.push(`${relative}:${index + 1}:${token}`);
          }
        }
      }
    }

    expect(
      offenders,
      `focus/ring visual utilities must stay removed; found: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
    expect(Object.fromEntries(approvedCounts)).toEqual(
      Object.fromEntries(
        [...APPROVED_FOCUS_UTILITIES].flatMap(([file, tokens]) =>
          [...tokens].map((token) => [`${file}:${token}`, 1]),
        ),
      ),
    );
  });
});
