/** Exercises dev health-check option validation without starting the dev stack. */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parsePort } from "../dev-health-check.mjs";

const scriptPath = fileURLToPath(
  new URL("../dev-health-check.mjs", import.meta.url),
);

describe("dev health-check port options", () => {
  test("preserves defaults and valid CLI overrides", () => {
    expect(parseArgs([], {})).toMatchObject({ uiPort: 2138, apiPort: 31337 });
    expect(parseArgs(["--ui-port=65535", "--api-port=1"], {})).toMatchObject({
      uiPort: 65535,
      apiPort: 1,
    });
  });

  test("uses validated environment overrides with UI-specific precedence", () => {
    expect(
      parseArgs([], {
        ELIZA_UI_PORT: "4321",
        ELIZA_PORT: "5432",
        ELIZA_API_PORT: "6543",
      }),
    ).toMatchObject({ uiPort: 4321, apiPort: 6543 });
    expect(parseArgs([], { ELIZA_PORT: "5432" })).toMatchObject({
      uiPort: 5432,
      apiPort: 31337,
    });
  });

  test.each([
    "",
    "0",
    "-1",
    "+1",
    "1.5",
    "1junk",
    "NaN",
    "Infinity",
    "65536",
    "9007199254740992",
  ])("rejects invalid port %p", (value) => {
    expect(() => parsePort(value, "--ui-port")).toThrow(
      "--ui-port must be a decimal TCP port from 1 to 65535",
    );
  });

  test("rejects malformed environment ports at their source", () => {
    expect(() => parseArgs([], { ELIZA_UI_PORT: "0" })).toThrow(
      "ELIZA_UI_PORT must be a decimal TCP port from 1 to 65535",
    );
    expect(() => parseArgs([], { ELIZA_API_PORT: "65536" })).toThrow(
      "ELIZA_API_PORT must be a decimal TCP port from 1 to 65535",
    );
  });

  test("lets explicit CLI ports override malformed environment values", () => {
    expect(
      parseArgs(["--ui-port=1234", "--api-port=5678"], {
        ELIZA_UI_PORT: "invalid",
        ELIZA_API_PORT: "65536",
      }),
    ).toMatchObject({ uiPort: 1234, apiPort: 5678 });
  });

  test("real CLI rejects before creating output or starting the dev stack", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "dev-health-check-test-"));
    const logDir = path.join(parent, "logs");
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--ui-port=65536", `--log-dir=${logDir}`],
      { cwd: parent, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "--ui-port must be a decimal TCP port from 1 to 65535",
    );
    expect(result.stdout).not.toContain("starting: bun run dev");
    expect(existsSync(logDir)).toBe(false);
  });
});
