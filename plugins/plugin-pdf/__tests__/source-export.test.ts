/** The workspace source condition must not require stale generated dist files. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
function resolveEntry(source: boolean): string {
  const result = spawnSync(process.execPath, [
    ...(source ? ["--conditions=eliza-source"] : []),
    "--input-type=module", "--eval",
    'console.log(import.meta.resolve("@elizaos/plugin-pdf"))',
  ], { cwd: root, encoding: "utf8", timeout: 5000,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

test("source condition resolves the real root TypeScript entry without importing it", () => {
  const entry = new URL("../index.ts", import.meta.url);
  expect(existsSync(entry)).toBe(true);
  expect(resolveEntry(true)).toBe(entry.href);
});

test("ordinary consumers retain the published dist entry", () => {
  expect(resolveEntry(false)).toBe(new URL("../dist/index.js", import.meta.url).href);
});
