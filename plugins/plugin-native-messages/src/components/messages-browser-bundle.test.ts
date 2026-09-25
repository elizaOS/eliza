/** Build the real browser entry: source-only Node tests cannot catch server
 * runtime initialization accidentally pulled into a dynamically loaded view. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it } from "vitest";
import { testOutputPath } from "../../../../packages/scripts/lib/test-output.ts";

it("builds Messages with browser contracts and no server async context", () => {
  const packageDir = path.resolve(import.meta.dirname, "../..");
  const require = createRequire(path.join(packageDir, "package.json"));
  const viteCli = path.join(
    path.dirname(require.resolve("vite/package.json")),
    "bin/vite.js",
  );
  const parent = testOutputPath("native-messages-browser-bundle");
  mkdirSync(parent, { recursive: true });
  const output = mkdtempSync(path.join(parent, "build-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        viteCli,
        "build",
        "--config",
        "vite.config.views.ts",
        "--outDir",
        output,
      ],
      {
        cwd: packageDir,
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const bundle = readFileSync(path.join(output, "bundle.js"), "utf8");
    expect(bundle).toContain('from "@elizaos/shared/browser-contracts"');
    expect(bundle).toContain("MessagesView");
    expect(bundle).toContain("interact");
    expect(bundle).not.toMatch(
      /AsyncLocalStorage|node:async_hooks|@elizaos\/core/,
    );
    const map = JSON.parse(
      readFileSync(path.join(output, "bundle.js.map"), "utf8"),
    ) as { sources: string[] };
    expect(
      map.sources.some((source) => source.includes("packages/core/")),
    ).toBe(false);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 90_000);
