/**
 * `plugins/plugin-coding-tools` is ESM (`package.json` -> `"type": "module"`),
 * so a bare `require(...)` is a free variable on real Node and throws
 * `ReferenceError: require is not defined` the first time the path runs. bun and
 * the vitest module runner both define `require`, so a behavioural test cannot
 * observe that crash — which is how `src/shell/approvals/analysis.ts` shipped a
 * `~`-expansion fallback through `require("node:os")` (same class as the
 * `packages/auth` guard). This pins the plugin source require-free.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL(".", import.meta.url));
const BARE_REQUIRE = /(^|[^.\w$])require\s*\(/;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.includes(".test.") || entry.name.includes(".spec.")) {
      continue;
    }
    found.push(full);
  }
  return found;
}

it("keeps the plugin source free of bare require() calls", () => {
  const offenders = sourceFiles(SRC_ROOT)
    .filter((file) => BARE_REQUIRE.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(SRC_ROOT, file));

  expect(
    offenders,
    "this package is ESM; a bare require() throws under Node. Use a static import.",
  ).toEqual([]);
});
