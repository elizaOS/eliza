/** Exercises real runtime critical paths behavior with deterministic app-core test fixtures. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Mock-mount vs real-runtime quarantine (issue #9943 item 11).
 *
 * The repo's e2e standard is "E2E must catch real bugs, not mock-mount smoke."
 * Specs are TAGGED by filename:
 *   - `*.real.test.ts` / `*.real.e2e.test.ts` / `*.live.test.ts` /
 *     `*.live.e2e.test.ts` run against a REAL AgentRuntime (createRealTestRuntime
 *     / a live agent server). They are quarantined out of the default unit lane
 *     (see vitest.config.ts `exclude`) and run in the post-merge / live lane.
 *   - every other `*.spec.ts` / `*.test.ts` mounts a mocked agent.
 *
 * This guard pins the load-bearing half of the standard: the auth / chat / wallet
 * critical paths must each keep at least one REAL-runtime variant, so a refactor
 * can't silently drop real-runtime coverage and leave only mock-mount smoke.
 * It does NOT run those heavy specs — it asserts the tagged files exist.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const REAL_RUNTIME_RE = /\.(real|live)\.(e2e\.)?test\.tsx?$/;

function realRuntimeSpecs(): string[] {
  // Critical-path real-runtime coverage lives where the behavior lives: auth/chat
  // against the app runtime/server (packages/app-core), wallet against real chains
  // in plugins/plugin-wallet.
  const tracked = execFileSync(
    "git",
    ["ls-files", "packages/app", "packages/app-core", "plugins/plugin-wallet"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return tracked
    .split(/\r?\n/)
    .filter((f) => f.length > 0 && REAL_RUNTIME_RE.test(f));
}

// Critical paths that must retain a real-runtime (non-mock-mount) variant.
const CRITICAL_PATHS: Array<{ name: string; match: RegExp }> = [
  { name: "auth", match: /(auth|login|bootstrap-token)/i },
  { name: "chat", match: /(chat|conversation|message|streaming)/i },
  { name: "wallet", match: /wallet/i },
];

describe("real-runtime critical-path coverage (#9943 item 11)", () => {
  const specs = realRuntimeSpecs();

  it("discovers the real-runtime spec corpus (guard against a glob regression)", () => {
    expect(specs.length).toBeGreaterThan(10);
  });

  for (const { name, match } of CRITICAL_PATHS) {
    it(`${name} keeps at least one real-runtime (non-mock-mount) variant`, () => {
      const variants = specs.filter((s) => match.test(path.basename(s)));
      expect(variants.length).toBeGreaterThan(0);
    });
  }
});
