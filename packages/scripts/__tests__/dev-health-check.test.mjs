/**
 * Focused coverage for dev-health-check TCP port validation: parser contract
 * plus real CLI boundary rejections before log/output directory creation or
 * `bun run dev` startup.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_API_PORT,
  DEFAULT_UI_PORT,
  parseArgs,
  parseTcpPort,
  resolveApiPortFromEnv,
  resolveUiPortFromEnv,
} from "../dev-health-check.mjs";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dev-health-check.mjs",
);

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      // Drop inherited ports so CLI/env cases are isolated.
      ELIZA_UI_PORT: undefined,
      ELIZA_PORT: undefined,
      ELIZA_API_PORT: undefined,
      ...env,
    },
    timeout: 5_000,
  });
}

describe("parseTcpPort", () => {
  test("accepts boundary and default ports", () => {
    expect(parseTcpPort("1", "--ui-port")).toBe(1);
    expect(parseTcpPort("65535", "--api-port")).toBe(65535);
    expect(parseTcpPort(String(DEFAULT_UI_PORT), "--ui-port")).toBe(
      DEFAULT_UI_PORT,
    );
    expect(parseTcpPort(String(DEFAULT_API_PORT), "--api-port")).toBe(
      DEFAULT_API_PORT,
    );
  });

  test("rejects zero, out-of-range, partial, signed, and non-decimal forms", () => {
    const bad = [
      "0",
      "65536",
      "99999",
      "-1",
      "1.5",
      "31337junk",
      "0x10",
      "1e2",
      "031337",
      "",
      " ",
      "NaN",
      "Infinity",
      " 31337 ",
    ];
    for (const value of bad) {
      expect(() => parseTcpPort(value, "--ui-port")).toThrow(
        /must be a TCP port integer from 1 to 65535/,
      );
    }
  });
});

describe("resolveUiPortFromEnv", () => {
  test("uses default when unset or empty", () => {
    expect(resolveUiPortFromEnv({})).toBe(DEFAULT_UI_PORT);
    expect(resolveUiPortFromEnv({ ELIZA_UI_PORT: "" })).toBe(DEFAULT_UI_PORT);
    expect(resolveUiPortFromEnv({ ELIZA_PORT: "" })).toBe(DEFAULT_UI_PORT);
  });

  test("ELIZA_UI_PORT takes precedence over ELIZA_PORT", () => {
    expect(
      resolveUiPortFromEnv({ ELIZA_UI_PORT: "41234", ELIZA_PORT: "40000" }),
    ).toBe(41234);
    expect(resolveUiPortFromEnv({ ELIZA_PORT: "40001" })).toBe(40001);
  });

  test("fails closed on explicit invalid env values", () => {
    for (const value of ["0", "notaport", "2138junk", "99999", "65536"]) {
      expect(() => resolveUiPortFromEnv({ ELIZA_UI_PORT: value })).toThrow(
        /ELIZA_UI_PORT must be a TCP port integer from 1 to 65535/,
      );
      expect(() => resolveUiPortFromEnv({ ELIZA_PORT: value })).toThrow(
        /ELIZA_PORT must be a TCP port integer from 1 to 65535/,
      );
    }
  });
});

describe("resolveApiPortFromEnv", () => {
  test("uses default when unset or empty", () => {
    expect(resolveApiPortFromEnv({})).toBe(DEFAULT_API_PORT);
    expect(resolveApiPortFromEnv({ ELIZA_API_PORT: "" })).toBe(
      DEFAULT_API_PORT,
    );
  });

  test("accepts a valid explicit env port", () => {
    expect(resolveApiPortFromEnv({ ELIZA_API_PORT: "41234" })).toBe(41234);
  });

  test("fails closed on explicit invalid env values", () => {
    for (const value of ["0", "notaport", "31337junk", "99999", "65536"]) {
      expect(() => resolveApiPortFromEnv({ ELIZA_API_PORT: value })).toThrow(
        /ELIZA_API_PORT must be a TCP port integer from 1 to 65535/,
      );
    }
  });
});

describe("parseArgs port wiring", () => {
  test("CLI ports override env and defaults", () => {
    const options = parseArgs(["--ui-port=44444", "--api-port=45555"], {
      ELIZA_UI_PORT: "40000",
      ELIZA_API_PORT: "40001",
    });
    expect(options.uiPort).toBe(44444);
    expect(options.apiPort).toBe(45555);
  });

  test("CLI port overrides suppress invalid values from the same env source", () => {
    const options = parseArgs(["--ui-port=44444", "--api-port=45555"], {
      ELIZA_UI_PORT: "notaport",
      ELIZA_PORT: "also-bad",
      ELIZA_API_PORT: "still-bad",
    });
    expect(options.uiPort).toBe(44444);
    expect(options.apiPort).toBe(45555);
  });

  test("env ports apply when CLI ports are omitted", () => {
    const options = parseArgs([], {
      ELIZA_UI_PORT: "40002",
      ELIZA_API_PORT: "40003",
    });
    expect(options.uiPort).toBe(40002);
    expect(options.apiPort).toBe(40003);
  });

  test("defaults apply when CLI and env are omitted", () => {
    const options = parseArgs([], {});
    expect(options.uiPort).toBe(DEFAULT_UI_PORT);
    expect(options.apiPort).toBe(DEFAULT_API_PORT);
  });

  test("rejects invalid CLI ports", () => {
    expect(() => parseArgs(["--ui-port=99999"], {})).toThrow(
      /--ui-port must be a TCP port integer from 1 to 65535/,
    );
    expect(() => parseArgs(["--api-port=0"], {})).toThrow(
      /--api-port must be a TCP port integer from 1 to 65535/,
    );
    expect(() => parseArgs(["--ui-port=44444=garbage"], {})).toThrow(
      /--ui-port must be a TCP port integer from 1 to 65535/,
    );
  });
});

describe("dev-health-check CLI boundary", () => {
  test("--help prints usage and exits 0", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--ui-port");
    expect(result.stdout).toContain("--api-port");
    expect(result.stdout).toContain("1-65535");
  });

  test("--help ignores invalid environment overrides", () => {
    const result = runCli(["--help"], {
      ELIZA_UI_PORT: "notaport",
      ELIZA_API_PORT: "also-bad",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stderr).toBe("");
  });

  test("explicit CLI ports ignore invalid matching environment overrides", () => {
    const result = runCli(
      ["--ui-port=44444", "--api-port=45555", "--seconds=0"],
      {
        ELIZA_UI_PORT: "notaport",
        ELIZA_PORT: "also-bad",
        ELIZA_API_PORT: "still-bad",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--seconds must be a positive number/);
    expect(result.stderr).not.toMatch(/ELIZA_(?:UI|API)?_?PORT/);
    expect(result.stdout).not.toContain("[dev-health-check] starting:");
  });

  test("rejects noncanonical operands before creating output", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "dev-health-ports-"));
    const logDir = path.join(directory, "nested-logs");
    try {
      const extraEquals = runCli([
        `--log-dir=${logDir}`,
        "--ui-port=44444=garbage",
      ]);
      expect(extraEquals.status).not.toBe(0);
      expect(extraEquals.stderr).toMatch(/--ui-port must be a TCP port/);
      expect(existsSync(logDir)).toBe(false);

      const paddedEnv = runCli([`--log-dir=${logDir}`], {
        ELIZA_API_PORT: " 31337 ",
      });
      expect(paddedEnv.status).not.toBe(0);
      expect(paddedEnv.stderr).toMatch(/ELIZA_API_PORT must be a TCP port/);
      expect(existsSync(logDir)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects invalid --ui-port before log/output or dev startup", () => {
    for (const value of ["0", "99999", "65536", "2138junk", "-1", "1.5"]) {
      const result = runCli([`--ui-port=${value}`]);
      expect(result.status).not.toBe(0);
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).toMatch(
        /--ui-port must be a TCP port integer from 1 to 65535/,
      );
      expect(combined).not.toContain("[dev-health-check] starting:");
      expect(combined).not.toContain("bun run dev");
    }
  });

  test("rejects invalid --api-port before log/output or dev startup", () => {
    for (const value of ["0", "99999", "65536", "31337junk", "-1", "1.5"]) {
      const result = runCli([`--api-port=${value}`]);
      expect(result.status).not.toBe(0);
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).toMatch(
        /--api-port must be a TCP port integer from 1 to 65535/,
      );
      expect(combined).not.toContain("[dev-health-check] starting:");
    }
  });

  test("rejects invalid ELIZA_UI_PORT before log/output or dev startup", () => {
    for (const value of ["0", "notaport", "2138junk", "99999"]) {
      const result = runCli([], { ELIZA_UI_PORT: value });
      expect(result.status).not.toBe(0);
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).toMatch(
        /ELIZA_UI_PORT must be a TCP port integer from 1 to 65535/,
      );
      expect(combined).not.toContain("[dev-health-check] starting:");
    }
  });

  test("rejects invalid ELIZA_PORT when ELIZA_UI_PORT is unset", () => {
    const result = runCli([], { ELIZA_PORT: "notaport" });
    expect(result.status).not.toBe(0);
    const combined = `${result.stdout}${result.stderr}`;
    expect(combined).toMatch(
      /ELIZA_PORT must be a TCP port integer from 1 to 65535/,
    );
    expect(combined).not.toContain("[dev-health-check] starting:");
  });

  test("rejects invalid ELIZA_API_PORT before log/output or dev startup", () => {
    for (const value of ["0", "notaport", "31337junk", "99999"]) {
      const result = runCli([], { ELIZA_API_PORT: value });
      expect(result.status).not.toBe(0);
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).toMatch(
        /ELIZA_API_PORT must be a TCP port integer from 1 to 65535/,
      );
      expect(combined).not.toContain("[dev-health-check] starting:");
    }
  });
});
