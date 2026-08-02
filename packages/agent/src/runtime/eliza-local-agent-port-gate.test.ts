/**
 * Verifies the `ELIZA_API_EXPOSE_PORT` gate that keeps `startEliza`'s API port
 * closed under Android local-agent (stdio) mode unless explicitly re-exposed
 * (#12352, #12180). Deterministic and boot-free: the typed boot plan is driven
 * directly, plus source assertions verify that startup consumes its decision.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureAgentEnvironment,
  resolveBootPlan,
  resolveBootPolicy,
} from "./boot-pipeline.ts";

/**
 * Port-gate wiring for the Android local-agent stdio switch (#12352, #12180).
 *
 * The agent-package `startEliza` binds the API port in its server-only path; the
 * Android bridge boots it with `localAgentMode` so the port stays closed unless
 * `ELIZA_API_EXPOSE_PORT` re-opens it (dev/LAN/e2e). `eliza.ts` pulls the whole
 * agent + plugin graph, so it can't be imported/booted in this lane — pin the
 * gate two ways: the typed boot plan and source-level assertions that
 * `startEliza` forwards `skipListen` and never hard-codes `localAgentMode`
 * itself (the default boot still binds).
 */

const ELIZA_SRC = readFileSync(join(import.meta.dirname, "eliza.ts"), "utf8");

function shouldSkipApiListen(
  localAgentMode: boolean | undefined,
  env: Record<string, string | undefined>,
): boolean {
  const environment = captureAgentEnvironment(env);
  const policy = resolveBootPolicy(environment);
  return !resolveBootPlan({
    localAgentMode,
    configured: true,
    cloudThinClient: false,
    apiExposePort: policy.apiExposePort,
  }).bindApiListener;
}

describe("agent local-agent IPC port gate (#12352)", () => {
  it("skips the listener only when localAgentMode is true and the port is not force-exposed", () => {
    expect(shouldSkipApiListen(true, {})).toBe(true);
  });

  it("binds the port when localAgentMode is unset (default server-only boot)", () => {
    expect(shouldSkipApiListen(undefined, {})).toBe(false);
    expect(shouldSkipApiListen(false, {})).toBe(false);
  });

  it("binds the port in local-agent mode when ELIZA_API_EXPOSE_PORT opts back in", () => {
    expect(shouldSkipApiListen(true, { ELIZA_API_EXPOSE_PORT: "1" })).toBe(
      false,
    );
    expect(shouldSkipApiListen(true, { ELIZA_API_EXPOSE_PORT: "true" })).toBe(
      false,
    );
  });
});

describe("agent eliza.ts source wiring (#12352)", () => {
  it("declares localAgentMode on StartElizaOptions", () => {
    expect(ELIZA_SRC).toMatch(/localAgentMode\?:\s*boolean/);
  });

  it("computes skipApiListen from the typed boot plan", () => {
    expect(ELIZA_SRC).toContain("resolveBootPlan");
    expect(ELIZA_SRC).toMatch(
      /const skipApiListen\s*=\s*!bootPlan\.bindApiListener/,
    );
  });

  it("forwards skipApiListen as startApiServer({ skipListen })", () => {
    expect(ELIZA_SRC).toMatch(/skipListen:\s*skipApiListen/);
  });

  it("does not hard-code localAgentMode true inside eliza.ts (the bridge sets it, not this file)", () => {
    expect(ELIZA_SRC).not.toMatch(/localAgentMode:\s*true/);
  });
});
