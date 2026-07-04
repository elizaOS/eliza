import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureApiTokenForBindHost,
  getConfiguredApiToken,
} from "./server-helpers-auth.ts";

/**
 * M7 (#12228): a wildcard bind (0.0.0.0 / ::) relaxes both the DNS-rebind Host
 * check (`isAllowedHost`) and the CORS origin check (`resolveCorsOrigin`
 * reflects any origin with credentials). With `ELIZA_DISABLE_AUTO_API_TOKEN=1`
 * and no explicit `ELIZA_API_TOKEN`, the pre-fix code silently returned with no
 * token — leaving the server listening on every interface with *no*
 * authenticated boundary and both browser-origin protections off.
 *
 * `ensureApiTokenForBindHost` must now REFUSE that combo: force a generated
 * token so a real auth boundary exists. The disable flag is still honored for
 * loopback and specific (non-wildcard) non-loopback IP binds, which keep the
 * Host + CORS guards enforced.
 */
const ENV_KEYS = [
  "ELIZA_API_BIND",
  "ELIZA_API_TOKEN",
  "ELIZA_DISABLE_AUTO_API_TOKEN",
  "ELIZA_CLOUD_PROVISIONED",
  "STEWARD_AGENT_TOKEN",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_API_KEY",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("ensureApiTokenForBindHost — M7 wildcard-bind + disabled auto-token", () => {
  it("forces a generated token for a wildcard bind even when auto-token is disabled", () => {
    process.env.ELIZA_API_BIND = "0.0.0.0";
    process.env.ELIZA_DISABLE_AUTO_API_TOKEN = "1";
    expect(getConfiguredApiToken()).toBeUndefined();

    ensureApiTokenForBindHost("0.0.0.0");

    const token = getConfiguredApiToken();
    expect(token).toBeTruthy();
    // 32 random bytes → 64 hex chars.
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("forces a generated token for the IPv6 wildcard bind (::) too", () => {
    process.env.ELIZA_API_BIND = "::";
    process.env.ELIZA_DISABLE_AUTO_API_TOKEN = "1";
    expect(getConfiguredApiToken()).toBeUndefined();

    ensureApiTokenForBindHost("::");

    expect(getConfiguredApiToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("still honors the disable flag on a loopback bind (no token forced)", () => {
    process.env.ELIZA_API_BIND = "127.0.0.1";
    process.env.ELIZA_DISABLE_AUTO_API_TOKEN = "1";

    ensureApiTokenForBindHost("127.0.0.1");

    expect(getConfiguredApiToken()).toBeUndefined();
  });

  it("still honors the disable flag on a specific non-loopback IP bind (Host+CORS stay enforced there)", () => {
    process.env.ELIZA_API_BIND = "192.168.1.5";
    process.env.ELIZA_DISABLE_AUTO_API_TOKEN = "1";

    ensureApiTokenForBindHost("192.168.1.5");

    expect(getConfiguredApiToken()).toBeUndefined();
  });

  it("never overrides an explicitly configured token on a wildcard bind", () => {
    process.env.ELIZA_API_BIND = "0.0.0.0";
    process.env.ELIZA_DISABLE_AUTO_API_TOKEN = "1";
    process.env.ELIZA_API_TOKEN = "operator-supplied-token";

    ensureApiTokenForBindHost("0.0.0.0");

    expect(getConfiguredApiToken()).toBe("operator-supplied-token");
  });

  it("generates a token for a wildcard bind when the disable flag is unset (pre-existing behavior preserved)", () => {
    process.env.ELIZA_API_BIND = "0.0.0.0";

    ensureApiTokenForBindHost("0.0.0.0");

    expect(getConfiguredApiToken()).toMatch(/^[0-9a-f]{64}$/);
  });
});
