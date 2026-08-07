/**
 * M7 (#12228): a wildcard bind (0.0.0.0 / ::) relaxes both the DNS-rebind Host
 * check (`isAllowedHost`) and the CORS origin check (`resolveCorsOrigin` reflects
 * any origin with credentials). Left tokenless on a wildcard bind — with
 * `ELIZA_DISABLE_AUTO_API_TOKEN=1` and no explicit `ELIZA_API_TOKEN` — the server
 * would listen on every interface with no authenticated boundary and both
 * browser-origin protections off, so `ensureApiTokenForBindHost` REFUSES that
 * combo and forces a generated token. The disable flag is still honored for
 * loopback and specific (non-wildcard) non-loopback IP binds, which keep the
 * Host + CORS guards enforced.
 */
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureApiTokenForBindHost,
  getConfiguredApiToken,
  resolveTerminalRunRejection,
} from "./server-helpers-auth.ts";

const ENV_KEYS = [
  "ELIZA_API_BIND",
  "ELIZA_API_TOKEN",
  "ELIZA_API_AUTH_TOKEN",
  "ELIZA_DISABLE_AUTO_API_TOKEN",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_TERMINAL_RUN_TOKEN",
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

// The legacy compat key `ELIZA_API_AUTH_TOKEN` is a caller-side fallback for
// requests this process makes back to its own API. It must never count as the
// server's configured inbound token: promoting it would satisfy the early
// return below (skipping the #12228 wildcard-bind auto-token) and would flip
// `apiTokenEnabled` in the terminal boundary (403-ing loopback terminal runs
// that develop allows). These tests pin the develop-parity behavior under a
// legacy-only env.
describe("legacy-only ELIZA_API_AUTH_TOKEN stays caller-side", () => {
  it("still mints the wildcard-bind auto-token when only the legacy key is set", () => {
    process.env.ELIZA_API_BIND = "0.0.0.0";
    process.env.ELIZA_API_AUTH_TOKEN = "legacy-plugin-compat-token";
    expect(getConfiguredApiToken()).toBeUndefined();

    ensureApiTokenForBindHost("0.0.0.0");

    const token = getConfiguredApiToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe("legacy-plugin-compat-token");
    expect(process.env.ELIZA_API_AUTH_TOKEN).toBe("legacy-plugin-compat-token");
  });

  it("keeps loopback terminal runs in compatibility mode under a legacy-only config", () => {
    process.env.ELIZA_API_AUTH_TOKEN = "legacy-plugin-compat-token";
    const req = { headers: {} } as http.IncomingMessage;

    // No terminal token configured and no canonical API token: the terminal
    // boundary must stay in compatibility mode (null = allowed), not treat the
    // legacy key as an enabled API token and 403 the run.
    expect(resolveTerminalRunRejection(req, {})).toBeNull();
  });

  it("still disables terminal runs when a canonical token is configured alongside the legacy key", () => {
    process.env.ELIZA_API_TOKEN = "canonical-token";
    process.env.ELIZA_API_AUTH_TOKEN = "legacy-plugin-compat-token";
    const req = { headers: {} } as http.IncomingMessage;

    expect(resolveTerminalRunRejection(req, {})).toMatchObject({
      status: 403,
    });
  });
});
