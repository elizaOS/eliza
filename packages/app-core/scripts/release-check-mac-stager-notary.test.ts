/**
 * Notarization-credential preflight for the macOS artifact stager.
 *
 * These run the REAL stager script, not a fixture: the behaviour under test is
 * the script's own exit path, so a re-implementation would test the
 * re-implementation. Only `uname` is stubbed, so the darwin-only guard at the
 * top of the script does not make the suite macOS-only.
 *
 * The defect these pin: notarization is gated on ELECTROBUN_APPLEID,
 * ELECTROBUN_APPLEIDPASS and ELECTROBUN_TEAMID together. They arrive from three
 * separate CI secrets, so one unset/renamed/rotated secret expands to an empty
 * string, the whole notarize+staple block is skipped, and the DMG is still
 * published under the same filename -- an un-notarized release that Gatekeeper
 * blocks on first launch, from a green build.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const stagerPath = path.join(
  here,
  "../platforms/electrobun/scripts/stage-macos-release-artifacts.sh",
);

const ALL_CREDENTIALS = [
  "ELECTROBUN_APPLEID",
  "ELECTROBUN_APPLEIDPASS",
  "ELECTROBUN_TEAMID",
] as const;

const CREDENTIAL_VALUES: Record<string, string> = {
  ELECTROBUN_APPLEID: "release@example.com",
  ELECTROBUN_APPLEIDPASS: "abcd-efgh-ijkl-mnop",
  ELECTROBUN_TEAMID: "TEAMID1234",
};

const INCOMPLETE_CREDENTIALS = "incomplete notarization credentials";
/** The first check the stager reaches once preflight has let it through. */
const PAST_PREFLIGHT = "no macOS updater tarball found";

let stubDir: string;
let artifactsDir: string;

beforeAll(() => {
  stubDir = mkdtempSync(path.join(os.tmpdir(), "eliza-stager-stub-"));
  artifactsDir = mkdtempSync(path.join(os.tmpdir(), "eliza-stager-artifacts-"));
  // The stager refuses to run off darwin. Stub `uname` so these cases exercise
  // the credential preflight on every platform the suite runs on.
  const unamePath = path.join(stubDir, "uname");
  writeFileSync(unamePath, "#!/bin/sh\necho Darwin\n");
  chmodSync(unamePath, 0o755);
});

afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
  rmSync(artifactsDir, { recursive: true, force: true });
});

/** Run the real stager with exactly `present` credentials set. */
function runStager(
  present: readonly string[],
  extraEnv: Record<string, string> = {},
): { status: number; output: string } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  for (const name of ALL_CREDENTIALS) delete env[name];
  delete env.ELECTROBUN_SKIP_CODESIGN;
  Object.assign(env, extraEnv);
  for (const name of present) env[name] = CREDENTIAL_VALUES[name];

  try {
    const stdout = execFileSync("bash", [stagerPath, artifactsDir], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

/** Every strict subset of the three credentials, i.e. every partial state. */
const partialStates = (() => {
  const states: string[][] = [];
  for (let mask = 1; mask < 7; mask += 1) {
    const present = ALL_CREDENTIALS.filter((_, i) => (mask & (1 << i)) !== 0);
    if (present.length < ALL_CREDENTIALS.length) states.push([...present]);
  }
  return states;
})();

describe("macOS stager notarization-credential preflight", () => {
  it.each(partialStates.map((p) => [p.join(",") || "(none)", p] as const))(
    "refuses a half-configured credential set: %s",
    (_label, present) => {
      const { status, output } = runStager(present);

      expect(status).not.toBe(0);
      expect(output).toContain(INCOMPLETE_CREDENTIALS);
      // It must name what is present and what is missing, so a CI operator can
      // see which secret lapsed rather than hunting a silent downgrade.
      for (const name of present) expect(output).toContain(name);
      for (const name of ALL_CREDENTIALS) {
        if (!present.includes(name)) expect(output).toContain(name);
      }
      // The refusal happens before any staging work is attempted.
      expect(output).not.toContain(PAST_PREFLIGHT);
    },
  );

  it("still runs with all three credentials set", () => {
    const { output } = runStager([...ALL_CREDENTIALS]);

    expect(output).not.toContain(INCOMPLETE_CREDENTIALS);
    expect(output).toContain(PAST_PREFLIGHT);
  });

  it("still runs with no credentials set, and says the DMG is not notarized", () => {
    const { output } = runStager([]);

    expect(output).not.toContain(INCOMPLETE_CREDENTIALS);
    expect(output).toContain(PAST_PREFLIGHT);
    expect(output).toContain("the DMG will not be notarized");
  });

  it("leaves an explicit codesign opt-out untouched", () => {
    // ELECTROBUN_SKIP_CODESIGN=1 already means "no signing this run", so a
    // partial credential set is not a misconfiguration there.
    const { output } = runStager([ALL_CREDENTIALS[0]], {
      ELECTROBUN_SKIP_CODESIGN: "1",
    });

    expect(output).not.toContain(INCOMPLETE_CREDENTIALS);
    expect(output).toContain(PAST_PREFLIGHT);
  });

  it("does not inherit codesign opt-out from the test runner", () => {
    const previous = process.env.ELECTROBUN_SKIP_CODESIGN;
    process.env.ELECTROBUN_SKIP_CODESIGN = "1";
    try {
      const { status, output } = runStager([ALL_CREDENTIALS[0]]);

      expect(status).not.toBe(0);
      expect(output).toContain(INCOMPLETE_CREDENTIALS);
    } finally {
      if (previous === undefined) delete process.env.ELECTROBUN_SKIP_CODESIGN;
      else process.env.ELECTROBUN_SKIP_CODESIGN = previous;
    }
  });
});
