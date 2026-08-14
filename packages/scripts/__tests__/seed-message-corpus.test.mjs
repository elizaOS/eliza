/**
 * Focused coverage for seed-message-corpus API port validation: parser contract
 * plus real CLI boundary rejections before any network request.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";
import {
  DEFAULT_API_PORT,
  parseArgs,
  parseTcpPort,
  resolveApiPortFromEnv,
} from "../seed-message-corpus.mjs";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "seed-message-corpus.mjs",
);

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      // Drop inherited API port so CLI/env cases are isolated.
      ELIZA_API_PORT: undefined,
      ...env,
    },
    timeout: 5_000,
  });
}

describe("parseTcpPort", () => {
  test("accepts boundary and default ports", () => {
    expect(parseTcpPort("1", "--api-port")).toBe(1);
    expect(parseTcpPort("65535", "--api-port")).toBe(65535);
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
      "31337=garbage",
      " 31337 ",
      "0x10",
      "1e2",
      "031337",
      "",
      " ",
      "NaN",
      "Infinity",
    ];
    for (const value of bad) {
      expect(() => parseTcpPort(value, "--api-port")).toThrow(
        /must be a TCP port integer from 1 to 65535/,
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
  test("CLI --api-port overrides env and default", () => {
    const options = parseArgs(["--api-port=44444"], {
      ELIZA_API_PORT: "notaport",
    });
    expect(options.apiPort).toBe(44444);
  });

  test("env port applies when CLI port is omitted", () => {
    const options = parseArgs([], { ELIZA_API_PORT: "40001" });
    expect(options.apiPort).toBe(40001);
  });

  test("default applies when CLI and env are omitted", () => {
    const options = parseArgs([], {});
    expect(options.apiPort).toBe(DEFAULT_API_PORT);
  });
});

describe("parseArgs canonical integer flags", () => {
  test("accepts canonical decimal counts and seeds", () => {
    const options = parseArgs(
      ["--conversations=24", "--seed=99", "--api-port=31337"],
      {},
    );
    expect(options.body.conversations).toBe(24);
    expect(options.body.seed).toBe(99);
  });

  test("rejects coercible non-canonical forms the same way --api-port already does", () => {
    // Number("0x10") is 16 and Number("1e2") is 100, so a hex seed or a
    // scientific count used to silently seed with a different valid value.
    for (const argv of [
      ["--seed=0x10"],
      ["--seed=1e2"],
      ["--seed= 42 "],
      ["--seed= 7 8"],
      ["--conversations=1e2"],
      ["--conversations= 12 "],
      ["--conversations=010"],
      ["--conversations=12abc"],
      ["--messages=3.5"],
      ["--span-months=0x2"],
      ["--facts=1e1"],
    ]) {
      expect(() => parseArgs(argv, {})).toThrow(/must be/);
    }
  });
});

describe("seed-message-corpus CLI boundary", () => {
  test("--help prints usage and exits 0", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--api-port");
  });

  test("rejects invalid --api-port before any seed request", () => {
    for (const value of [
      "0",
      "99999",
      "65536",
      "31337junk",
      "31337=garbage",
      " 31337 ",
      "-1",
      "1.5",
    ]) {
      const result = runCli([`--api-port=${value}`]);
      expect(result.status).not.toBe(0);
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).toMatch(
        /--api-port must be a TCP port integer from 1 to 65535/,
      );
      expect(combined).not.toContain("Seeding backdated message corpus");
    }
  });

  test("rejects invalid ELIZA_API_PORT before any seed request", () => {
    for (const value of ["0", "notaport", "31337junk", " 31337 ", "99999"]) {
      const result = runCli([], { ELIZA_API_PORT: value });
      expect(result.status).not.toBe(0);
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).toMatch(
        /ELIZA_API_PORT must be a TCP port integer from 1 to 65535/,
      );
      expect(combined).not.toContain("Seeding backdated message corpus");
    }
  });

  test("valid CLI port overrides invalid env without entering network work", () => {
    const result = runCli(["--api-port=44444", "--messages=not-an-integer"], {
      ELIZA_API_PORT: "notaport",
    });
    const combined = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(combined).toContain("--messages must be an integer");
    expect(combined).not.toContain("ELIZA_API_PORT must be");
    expect(combined).not.toContain("Seeding backdated message corpus");
  });

  test("--help bypasses an invalid environment port", () => {
    const result = runCli(["--help"], { ELIZA_API_PORT: "notaport" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stderr).toBe("");
  });
});
