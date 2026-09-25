/**
 * Regression coverage for the vault-sentinel gateway-token leak.
 *
 * Root cause: the host's vault-bootstrap rewrites secret
 * config keys (incl. `ELIZA_MODEL_GATEWAY_TOKEN`) to `vault://<key>` sentinels.
 * `resolveModelGatewayConfig()` reads that value verbatim, so before this fix
 * the literal string `vault://ELIZA_MODEL_GATEWAY_TOKEN` was injected as the
 * sub-agent's `ANTHROPIC_API_KEY`, the pool meter 401'd, and every claude
 * sub-agent died ~3 min after going ready. Codex was unaffected (drops the
 * gateway key). Readiness meanwhile reported ready:true/problems:[].
 *
 * These tests FAIL on clean develop (the sentinel leaks into the child env and
 * readiness is green) and PASS with the fix (the sentinel is dereferenced to
 * plaintext, an unresolvable sentinel fails closed instead of leaking, and
 * readiness reports a problem).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assessCodingAccountReadiness,
  type ModelGatewayReadiness,
} from "./coding-account-selection.ts";
import {
  _setGatewayVaultForTesting,
  applyModelGatewayEnv,
  isVaultRef,
  MODEL_GATEWAY_TOKEN_KEY,
  MODEL_GATEWAY_URL_KEY,
  primeModelGatewayToken,
  resolveGatewayTokenValue,
  resolveModelGatewayConfig,
  resolveModelGatewayConfigResolved,
  resolveModelGatewayEffectiveTokenSync,
} from "./model-gateway.ts";

const REAL_TOKEN = "pool-abc123realgatewaytoken";
const GATEWAY_URL = "http://127.0.0.1:18811";
const TOKEN_VAULT_KEY = "ELIZA_MODEL_GATEWAY_TOKEN";
const SENTINEL = `vault://${TOKEN_VAULT_KEY}`;

/** Minimal in-memory vault fake exposing only get/has. */
function makeVaultFake(entries: Record<string, string>) {
  return {
    has: async (key: string) => key in entries,
    get: async (key: string) => {
      if (!(key in entries)) throw new Error(`no entry for ${key}`);
      return entries[key];
    },
  };
}

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [MODEL_GATEWAY_URL_KEY, MODEL_GATEWAY_TOKEN_KEY];

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  // Reset the module vault + resolved-token cache between tests.
  _setGatewayVaultForTesting(null);
});

describe("model-gateway vault-sentinel deref", () => {
  it("resolveGatewayTokenValue passes a plain token through unchanged", async () => {
    const res = await resolveGatewayTokenValue(REAL_TOKEN);
    expect(res).toEqual({ token: REAL_TOKEN });
  });

  it("resolveGatewayTokenValue dereferences a vault:// sentinel to plaintext", async () => {
    const vault = makeVaultFake({ [TOKEN_VAULT_KEY]: REAL_TOKEN });
    const res = await resolveGatewayTokenValue(SENTINEL, vault);
    expect(res).toEqual({ token: REAL_TOKEN });
  });

  it("resolveGatewayTokenValue fails closed (key name only) on a missing entry", async () => {
    const vault = makeVaultFake({});
    const res = await resolveGatewayTokenValue(SENTINEL, vault);
    expect(res.token).toBeUndefined();
    expect(res.unresolvedKey).toBe(TOKEN_VAULT_KEY);
  });

  it("resolveGatewayTokenValue never echoes the vault error, only the key name", async () => {
    const vault = {
      has: async () => true,
      get: async () => {
        throw new Error("pglite-internal-storage-detail secret=xyz");
      },
    };
    const res = await resolveGatewayTokenValue(SENTINEL, vault);
    expect(res.token).toBeUndefined();
    expect(res.unresolvedKey).toBe(TOKEN_VAULT_KEY);
    expect(JSON.stringify(res)).not.toContain("pglite");
    expect(JSON.stringify(res)).not.toContain("xyz");
  });

  it("resolveModelGatewayConfig returns the raw sentinel verbatim (sync layer)", () => {
    process.env[MODEL_GATEWAY_URL_KEY] = GATEWAY_URL;
    process.env[MODEL_GATEWAY_TOKEN_KEY] = SENTINEL;
    const cfg = resolveModelGatewayConfig();
    expect(cfg).toEqual({ url: GATEWAY_URL, token: SENTINEL });
    // The sync layer intentionally does NOT deref — the spawn path must.
    expect(isVaultRef(cfg?.token ?? "")).toBe(true);
  });

  it("primeModelGatewayToken + sync accessor yield plaintext for a sentinel token", async () => {
    process.env[MODEL_GATEWAY_URL_KEY] = GATEWAY_URL;
    process.env[MODEL_GATEWAY_TOKEN_KEY] = SENTINEL;
    _setGatewayVaultForTesting(
      makeVaultFake({ [TOKEN_VAULT_KEY]: REAL_TOKEN }),
    );
    const primed = await primeModelGatewayToken();
    expect(primed).toEqual({ token: REAL_TOKEN });
    // After priming, the synchronous accessor buildEnv uses returns plaintext.
    expect(resolveModelGatewayEffectiveTokenSync(SENTINEL)).toBe(REAL_TOKEN);
  });

  it("sync accessor returns undefined for an un-primed / unresolvable sentinel (fail-closed)", async () => {
    process.env[MODEL_GATEWAY_URL_KEY] = GATEWAY_URL;
    process.env[MODEL_GATEWAY_TOKEN_KEY] = SENTINEL;
    _setGatewayVaultForTesting(makeVaultFake({}));
    const primed = await primeModelGatewayToken();
    expect(primed?.unresolvedKey).toBe(TOKEN_VAULT_KEY);
    // Never returns the sentinel; buildEnv treats undefined as fail-closed.
    expect(resolveModelGatewayEffectiveTokenSync(SENTINEL)).toBeUndefined();
  });

  it("BIDIRECTIONAL: applyModelGatewayEnv THROWS on a sentinel token (never injects it)", () => {
    // On clean develop applyModelGatewayEnv assigns gateway.token verbatim, so
    // the child env receives ANTHROPIC_API_KEY=vault://... and this expect
    // FAILS (no throw, and the leaked sentinel below asserts). With the fix it
    // throws before any assignment.
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "old" };
    expect(() =>
      applyModelGatewayEnv(env, { url: GATEWAY_URL, token: SENTINEL }),
    ).toThrow(/unresolved gateway token sentinel|did not resolve/i);
    // Defense-in-depth: the sentinel must NOT have been written to the env.
    expect(env.ANTHROPIC_API_KEY).not.toBe(SENTINEL);
    expect(env.OPENAI_API_KEY).not.toBe(SENTINEL);
  });

  it("applyModelGatewayEnv injects a real plaintext token normally", () => {
    const env: NodeJS.ProcessEnv = {};
    applyModelGatewayEnv(env, { url: GATEWAY_URL, token: REAL_TOKEN });
    expect(env.ANTHROPIC_API_KEY).toBe(REAL_TOKEN);
    expect(env.OPENAI_API_KEY).toBe(REAL_TOKEN);
    expect(env.ANTHROPIC_BASE_URL).toBe(GATEWAY_URL);
    expect(env.OPENAI_BASE_URL).toBe(GATEWAY_URL);
  });

  it("END-TO-END: primed sentinel resolves so applyModelGatewayEnv injects plaintext, not the sentinel", async () => {
    process.env[MODEL_GATEWAY_URL_KEY] = GATEWAY_URL;
    process.env[MODEL_GATEWAY_TOKEN_KEY] = SENTINEL;
    _setGatewayVaultForTesting(
      makeVaultFake({ [TOKEN_VAULT_KEY]: REAL_TOKEN }),
    );
    await primeModelGatewayToken();
    const cfg = resolveModelGatewayConfig();
    // Mirror the buildEnv logic: deref a sentinel token via the sync accessor.
    const effectiveToken = isVaultRef(cfg?.token ?? "")
      ? resolveModelGatewayEffectiveTokenSync(cfg?.token ?? "")
      : cfg?.token;
    expect(effectiveToken).toBe(REAL_TOKEN);
    const env: NodeJS.ProcessEnv = {};
    applyModelGatewayEnv(env, {
      url: cfg?.url ?? "",
      token: effectiveToken ?? "",
    });
    // The exact leak from the probe: ANTHROPIC_API_KEY must be plaintext.
    expect(env.ANTHROPIC_API_KEY).toBe(REAL_TOKEN);
    expect(env.ANTHROPIC_API_KEY).not.toBe(SENTINEL);
  });

  it("resolveModelGatewayConfigResolved returns plaintext when resolvable", async () => {
    process.env[MODEL_GATEWAY_URL_KEY] = GATEWAY_URL;
    process.env[MODEL_GATEWAY_TOKEN_KEY] = SENTINEL;
    _setGatewayVaultForTesting(
      makeVaultFake({ [TOKEN_VAULT_KEY]: REAL_TOKEN }),
    );
    const resolved = await resolveModelGatewayConfigResolved();
    expect(resolved).toEqual({ url: GATEWAY_URL, token: REAL_TOKEN });
  });

  it("resolveModelGatewayConfigResolved reports unresolvedKey when the sentinel does not resolve", async () => {
    process.env[MODEL_GATEWAY_URL_KEY] = GATEWAY_URL;
    process.env[MODEL_GATEWAY_TOKEN_KEY] = SENTINEL;
    _setGatewayVaultForTesting(makeVaultFake({}));
    const resolved = await resolveModelGatewayConfigResolved();
    expect(resolved).toEqual({
      url: GATEWAY_URL,
      unresolvedKey: TOKEN_VAULT_KEY,
    });
  });

  it("resolveModelGatewayConfigResolved is undefined when gateway mode is off", async () => {
    delete process.env[MODEL_GATEWAY_URL_KEY];
    delete process.env[MODEL_GATEWAY_TOKEN_KEY];
    expect(await resolveModelGatewayConfigResolved()).toBeUndefined();
  });
});

describe("readiness folds in the model-gateway verdict", () => {
  const healthyPool = {
    claude: [{ agentType: "claude", total: 4, enabled: 4, healthy: 4 }],
    codex: [{ agentType: "codex", total: 2, enabled: 2, healthy: 2 }],
  };

  it("BIDIRECTIONAL: readiness is NOT ready when the gateway token is an unresolved sentinel", () => {
    // On clean develop there is no gateway verdict, so with a healthy pool
    // readiness.ready === true and problems === [] (the false positive the
    // probe caught). With the fix, a configured-but-broken gateway pushes a
    // problem and flips ready to false.
    const gateway: ModelGatewayReadiness = {
      ok: false,
      configured: true,
      url: GATEWAY_URL,
      unresolvedKey: TOKEN_VAULT_KEY,
    };
    const readiness = assessCodingAccountReadiness(healthyPool, { gateway });
    expect(readiness.ready).toBe(false);
    expect(readiness.problems.some((p) => p.includes("model-gateway"))).toBe(
      true,
    );
    expect(readiness.gateway).toEqual(gateway);
  });

  it("readiness stays ready when the gateway token resolves and the pool is healthy", () => {
    const gateway: ModelGatewayReadiness = {
      ok: true,
      configured: true,
      url: GATEWAY_URL,
    };
    const readiness = assessCodingAccountReadiness(healthyPool, { gateway });
    expect(readiness.ready).toBe(true);
    expect(readiness.problems).toEqual([]);
    expect(readiness.gateway).toEqual(gateway);
  });

  it("no gateway verdict (direct-key mode) does not add a problem", () => {
    const readiness = assessCodingAccountReadiness(healthyPool, {});
    expect(readiness.ready).toBe(true);
    expect(readiness.gateway).toBeUndefined();
  });
});
