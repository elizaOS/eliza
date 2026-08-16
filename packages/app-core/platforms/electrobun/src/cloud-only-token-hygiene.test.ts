/** Exercises cloud-only local-API-token hygiene with deterministic app-core test fixtures. */
/*
 * Pins the token invariants behind `injectApiBase`'s "disabled" branch in
 * src/index.ts (a non-exported composition-root function; the load-bearing
 * comment lives there): when the desktop runs the runtime-less cloud-only
 * consumer bundle (ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT=1), that branch must
 * NEVER call configureDesktopLocalApiAuth(). Minting a local API token there
 * pushes it to the renderer, whose getCloudAuthToken falls back to it as a
 * fake Cloud credential and silently skips interactive sign-in. These tests
 * prove the seam that makes the fix hold: the disabled mode resolves from the
 * env flag alone, a token-free env resolves to NO token, and the only thing
 * that mints ELIZA_API_TOKEN is an explicit ensureDesktopApiToken call.
 */
import { resolveApiToken } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { resolveDesktopRuntimeMode } from "./api-base";
import { ensureDesktopApiToken } from "./native/agent";

describe("cloud-only token hygiene", () => {
  it("resolves the skip-embedded-agent flag to the disabled runtime mode", () => {
    const resolution = resolveDesktopRuntimeMode({
      ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT: "1",
    });
    expect(resolution.mode).toBe("disabled");
  });

  it("resolves NO api token from a disabled-mode env without ELIZA_API_TOKEN", () => {
    // This is exactly what injectApiBase's disabled branch publishes to the
    // renderer: resolveApiToken(env) with nothing minted — so the renderer's
    // cloud resolver has no fake local credential to fall back to.
    expect(
      resolveApiToken({ ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT: "1" }),
    ).toBeNull();
    expect(resolveApiToken({})).toBeNull();
  });

  it("mints a token only via an explicit ensureDesktopApiToken call", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(resolveApiToken(env)).toBeNull();

    const minted = ensureDesktopApiToken(env);

    expect(minted).not.toBe("");
    expect(env.ELIZA_API_TOKEN).toBe(minted);
    expect(resolveApiToken(env)).toBe(minted);
  });

  it("never overwrites an operator-provided token when minting", () => {
    const env: NodeJS.ProcessEnv = { ELIZA_API_TOKEN: "operator-token" };
    expect(ensureDesktopApiToken(env)).toBe("operator-token");
    expect(env.ELIZA_API_TOKEN).toBe("operator-token");
  });
});
