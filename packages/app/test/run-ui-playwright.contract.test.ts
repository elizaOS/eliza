/**
 * Executes the Playwright wrapper as its real CLI boundary while selecting no
 * app-specific config, proving command discovery, argument forwarding, and
 * child exit propagation without starting a browser or build stack.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(appDir, "scripts", "run-ui-playwright.mjs");

describe("run-ui-playwright CLI", () => {
  it("forwards --version to the installed Playwright child and exits cleanly", () => {
    const result = spawnSync(process.execPath, [runner, "--version"], {
      cwd: appDir,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Version \d+/);
  });
});
