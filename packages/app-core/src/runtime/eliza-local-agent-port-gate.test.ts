/** Exercises eliza local agent port gate behavior with deterministic app-core test fixtures. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveApiExposePort } from "@elizaos/shared";
import { describe, expect, it } from "vitest";

/**
 * Port-gate wiring for local-agent IPC mode (#12180).
 *
 * `eliza.ts` pulls the entire agent + plugin module graph, so it cannot be
 * imported into this vitest lane (nor booted headlessly here — that needs the
 * built dist). This pins the gate two ways:
 *
 *   1. The decision predicate (`localAgentMode === true` AND NOT
 *      `ELIZA_API_EXPOSE_PORT`) evaluated against the real
 *      `resolveApiExposePort` — the exact expression `eliza.ts` uses.
 *   2. Source-level assertions that `eliza.ts` computes `skipApiListen` from
 *      that predicate and forwards it as `startApiServer({ skipListen })`, and
 *      that no other caller path sets `localAgentMode` — so the default boot
 *      (desktop launcher / `eliza start` / server-only) still binds the port.
 */

const ELIZA_SRC = readFileSync(join(import.meta.dirname, "eliza.ts"), "utf8");

/** Mirror of the gate expression in eliza.ts (kept identical on purpose). */
function shouldSkipApiListen(
  localAgentMode: boolean | undefined,
  env: Record<string, string | undefined>,
): boolean {
  return localAgentMode === true && resolveApiExposePort(env) !== true;
}

describe("local-agent IPC port gate (#12180)", () => {
  it("skips the listener only when localAgentMode is true and the port is not force-exposed", () => {
    expect(shouldSkipApiListen(true, {})).toBe(true);
  });

  it("binds the port when localAgentMode is unset (default boot path)", () => {
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

  it("ignores the expose flag entirely when not in local-agent mode", () => {
    // A stray ELIZA_API_EXPOSE_PORT never causes a bind change on the default
    // path — the port was always bound there.
    expect(shouldSkipApiListen(undefined, { ELIZA_API_EXPOSE_PORT: "0" })).toBe(
      false,
    );
  });
});

describe("eliza.ts source wiring (#12180)", () => {
  it("declares localAgentMode on StartElizaOptionsExt", () => {
    expect(ELIZA_SRC).toMatch(/localAgentMode\?:\s*boolean/);
  });

  it("computes skipApiListen from localAgentMode + resolveApiExposePort", () => {
    expect(ELIZA_SRC).toContain("resolveApiExposePort");
    expect(ELIZA_SRC).toMatch(
      /const skipApiListen\s*=\s*[\s\S]*options\?\.localAgentMode === true/,
    );
    expect(ELIZA_SRC).toMatch(/resolveApiExposePort\(process\.env\) !== true/);
  });

  it("forwards skipApiListen as startApiServer({ skipListen })", () => {
    expect(ELIZA_SRC).toMatch(/skipListen:\s*skipApiListen/);
  });

  it("does not hard-code localAgentMode anywhere (no caller opts in yet)", () => {
    // The only occurrences of localAgentMode are the type field and the gate
    // read — nothing in eliza.ts assigns it true, so behavior is unchanged.
    expect(ELIZA_SRC).not.toMatch(/localAgentMode:\s*true/);
  });
});
