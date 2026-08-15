/**
 * Focused CLI-boundary tests for voice-duet numeric option validation.
 * Invalid numeric flags must fail before model load / duet startup.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseArgs, parsePositiveInteger } from "./voice-duet.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./voice-duet.mjs", import.meta.url));

describe("voice-duet parseArgs numeric validation", () => {
  it("keeps endless turns and default ringMs when omitted", () => {
    const args = parseArgs([]);
    expect(args.turns).toBe(Number.POSITIVE_INFINITY);
    expect(args.ringMs).toBe(200);
    expect(args.parallel).toBeNull();
  });

  it("parses valid numeric overrides", () => {
    expect(
      parseArgs([
        "--turns",
        "2",
        "--ring-ms",
        "200",
        "--parallel",
        "2",
        "--prewarm-lead-ms",
        "0",
      ]),
    ).toMatchObject({
      turns: 2,
      ringMs: 200,
      parallel: 2,
      prewarmLeadMs: 0,
    });
  });

  it.each(["", "0", "-3", "1.5", "10junk", "NaN", "Infinity", "+1"])(
    "rejects invalid --turns %p",
    (value) => {
      expect(() => parseArgs(["--turns", value])).toThrow(/--turns/);
    },
  );

  it("rejects missing --ring-ms without consuming the next flag", () => {
    expect(() => parseArgs(["--ring-ms", "--two-process"])).toThrow(
      /--ring-ms requires a value/,
    );
  });

  it("rejects malformed optional int knobs instead of null", () => {
    expect(() => parseArgs(["--parallel", "junk"])).toThrow(/--parallel/);
    expect(() => parseArgs(["--draft-max", "0"])).toThrow(/--draft-max/);
  });

  it("parsePositiveInteger accepts complete positives", () => {
    expect(parsePositiveInteger("1", "--turns")).toBe(1);
    expect(parsePositiveInteger("200", "--ring-ms")).toBe(200);
  });
});

describe("voice-duet real CLI rejection", () => {
  it("exits non-zero with a named flag before loading the voice stack", () => {
    // voice-duet is a Bun harness (`import.meta.main`); run via bun.
    const result = spawnSync("bun", [SCRIPT_PATH, "--turns", "junk"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--turns/);
    // Must not start prereq/model load chatter for a pure parse failure.
    expect(result.stdout + result.stderr).not.toMatch(
      /Loading|prereq|llama-server|OmniVoice/i,
    );
  });
});
