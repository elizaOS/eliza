/**
 * Verifies that the UI browser configurations never hand colocated
 * unit-test contracts to Playwright's suite collector.
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const appDir = path.resolve(import.meta.dirname, "..");
const playwrightCli = path.resolve(
  appDir,
  "../../node_modules/playwright/cli.js",
);

test.each([
  "playwright.ui-smoke.config.ts",
  "playwright.ui-packaged.config.ts",
])(
  "%s ignores colocated Vitest contracts",
  (config) => {
    const result = spawnSync(
      process.platform === "win32" ? "node.exe" : "node",
      [
        playwrightCli,
        "test",
        "--config",
        config,
        "--list",
        "test/ui-smoke/voice-live-trajectory.test.ts",
        "test/ui-smoke/provider-config.spec.ts",
      ],
      {
        cwd: appDir,
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).toContain("provider-config.spec.ts");
    expect(output).not.toContain("voice-live-trajectory.test.ts");
    expect(output).not.toContain("Cannot read properties of undefined");
  },
  25_000,
);
