/**
 * Contract tests for the evidence-root/secrets-dir derivation seam (paths.ts):
 * env overrides win without consulting the home lookup, blank/relative
 * overrides fail loudly, and the defaults stay on the real-home ~/.moltbot
 * layout. The identical contract is executed under Bun (this file's direct
 * imports) and under Node type stripping (a spawned `node` subprocess importing
 * the same module), because the #16180 leak was a runtime-behavior divergence
 * (Bun's homedir() ignoring a HOME reassignment) that a single-runtime test
 * could not observe.
 */

import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EVIDENCE_SUBPATH,
  DEFAULT_SECRETS_SUBPATH,
  EVIDENCE_ROOT_ENV,
  evidenceRoot,
  SECRETS_DIR_ENV,
  secretPath,
  secretsDir,
} from "./paths.ts";

const FAKE_HOME = "/fake-home";
const fakeHome = () => FAKE_HOME;
const forbiddenHome = (): string => {
  throw new Error("home lookup consulted although an override is set");
};

const originalEvidenceRoot = process.env[EVIDENCE_ROOT_ENV];
const originalSecretsDir = process.env[SECRETS_DIR_ENV];

afterEach(() => {
  if (originalEvidenceRoot === undefined) delete process.env[EVIDENCE_ROOT_ENV];
  else process.env[EVIDENCE_ROOT_ENV] = originalEvidenceRoot;
  if (originalSecretsDir === undefined) delete process.env[SECRETS_DIR_ENV];
  else process.env[SECRETS_DIR_ENV] = originalSecretsDir;
});

test("evidence root: override wins and the home lookup is never consulted", () => {
  expect(
    evidenceRoot({ [EVIDENCE_ROOT_ENV]: "/override/evidence" }, forbiddenHome),
  ).toBe("/override/evidence");
  // surrounding whitespace is tolerated, the path itself is kept verbatim
  expect(
    evidenceRoot(
      { [EVIDENCE_ROOT_ENV]: "  /override/evidence " },
      forbiddenHome,
    ),
  ).toBe("/override/evidence");
});

test("evidence root: default stays on the ~/.moltbot layout", () => {
  expect(evidenceRoot({}, fakeHome)).toBe(
    join(FAKE_HOME, DEFAULT_EVIDENCE_SUBPATH),
  );
  // live default (no override, real home lookup) — the CLI's non-test path
  expect(evidenceRoot({})).toBe(join(homedir(), DEFAULT_EVIDENCE_SUBPATH));
});

test("evidence root: default arguments read process.env", () => {
  process.env[EVIDENCE_ROOT_ENV] = "/from-process-env/evidence";
  expect(evidenceRoot()).toBe("/from-process-env/evidence");
});

test("secrets: override and default derivations", () => {
  expect(
    secretsDir({ [SECRETS_DIR_ENV]: "/override/secrets" }, forbiddenHome),
  ).toBe("/override/secrets");
  expect(secretsDir({}, fakeHome)).toBe(
    join(FAKE_HOME, DEFAULT_SECRETS_SUBPATH),
  );
  expect(
    secretPath(
      "deepgram",
      { [SECRETS_DIR_ENV]: "/override/secrets" },
      forbiddenHome,
    ),
  ).toBe("/override/secrets/deepgram.json");
  expect(secretPath("cartesia", {}, fakeHome)).toBe(
    join(FAKE_HOME, DEFAULT_SECRETS_SUBPATH, "cartesia.json"),
  );
  process.env[SECRETS_DIR_ENV] = "/from-process-env/secrets";
  expect(secretPath("deepgram")).toBe(
    "/from-process-env/secrets/deepgram.json",
  );
});

test("blank or relative overrides fail loudly instead of falling back to the real home", () => {
  expect(() => evidenceRoot({ [EVIDENCE_ROOT_ENV]: "" }, fakeHome)).toThrow(
    "set but blank",
  );
  expect(() => evidenceRoot({ [EVIDENCE_ROOT_ENV]: "   " }, fakeHome)).toThrow(
    "set but blank",
  );
  expect(() =>
    evidenceRoot({ [EVIDENCE_ROOT_ENV]: "relative/evidence" }, fakeHome),
  ).toThrow("must be an absolute path");
  expect(() => secretsDir({ [SECRETS_DIR_ENV]: "" }, fakeHome)).toThrow(
    "set but blank",
  );
  expect(() =>
    secretsDir({ [SECRETS_DIR_ENV]: "./secrets" }, fakeHome),
  ).toThrow("must be an absolute path");
});

test("the same contract holds under the Node runtime (type-stripped subprocess)", () => {
  const pathsUrl = new URL("./paths.ts", import.meta.url).href;
  // The script mirrors the Bun-leg assertions above and prints its observations
  // as JSON; the parent asserts equality so a divergence between runtimes (the
  // #16180 failure mode) surfaces as a concrete value diff.
  const nodeScript = [
    `const m = await import(${JSON.stringify(pathsUrl)});`,
    `const threw = (fn) => { try { fn(); return false; } catch { return true; } };`,
    `const noHome = () => { throw new Error("home lookup consulted although an override is set"); };`,
    `const out = {`,
    `  overrideWins: m.evidenceRoot({ [m.EVIDENCE_ROOT_ENV]: "/node-override/evidence" }, noHome),`,
    `  defaultUnderHome: m.evidenceRoot({}, () => "/node-fake-home"),`,
    `  secretsOverride: m.secretPath("deepgram", { [m.SECRETS_DIR_ENV]: "/node-override/secrets" }, noHome),`,
    `  secretsDefault: m.secretPath("cartesia", {}, () => "/node-fake-home"),`,
    `  blankRootThrows: threw(() => m.evidenceRoot({ [m.EVIDENCE_ROOT_ENV]: "  " }, () => "/h")),`,
    `  relativeRootThrows: threw(() => m.evidenceRoot({ [m.EVIDENCE_ROOT_ENV]: "relative/evidence" }, () => "/h")),`,
    `  blankSecretsThrows: threw(() => m.secretsDir({ [m.SECRETS_DIR_ENV]: "" }, () => "/h")),`,
    `  relativeSecretsThrows: threw(() => m.secretsDir({ [m.SECRETS_DIR_ENV]: "./secrets" }, () => "/h")),`,
    `};`,
    `process.stdout.write(JSON.stringify(out));`,
  ].join("\n");
  const res = spawnSync("node", ["--input-type=module", "--eval", nodeScript], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(res.error).toBeUndefined();
  if (res.status !== 0) {
    throw new Error(`node leg failed (status ${res.status}): ${res.stderr}`);
  }
  const observed: unknown = JSON.parse(res.stdout);
  expect(observed).toEqual({
    overrideWins: "/node-override/evidence",
    defaultUnderHome: join("/node-fake-home", DEFAULT_EVIDENCE_SUBPATH),
    secretsOverride: "/node-override/secrets/deepgram.json",
    secretsDefault: join(
      "/node-fake-home",
      DEFAULT_SECRETS_SUBPATH,
      "cartesia.json",
    ),
    blankRootThrows: true,
    relativeRootThrows: true,
    blankSecretsThrows: true,
    relativeSecretsThrows: true,
  });
});
