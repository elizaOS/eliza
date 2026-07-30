/**
 * Error-policy proof for the team-pool registry's J4 degrade layer: a
 * legitimately-empty pool result and an internal credential/decrypt failure
 * must be DISTINGUISHABLE. Both degrade to `null` (the additive-layer contract
 * verified against `route.ts:selectPooledInferenceCredential` → platform env),
 * but only the internal failure surfaces observably via `logger.warn` with
 * error context — it is never silently swallowed. Deterministic in-memory
 * doubles for the pool brain, deps, secrets vault, and logger; no DB.
 */

import { describe, expect, it, mock } from "bun:test";

const mockSelect = mock();
const mockRefresh = mock(async () => undefined);
const mockSecretIdFor = mock();
const mockGetDecryptedValue = mock();
const mockMarkNeedsReauth = mock(async () => undefined);
const mockMarkRateLimited = mock(async () => undefined);
const mockWarn = mock();
const mockRecordInferenceUse = mock(async () => undefined);

mock.module("../../utils/logger", () => ({
  logger: { warn: mockWarn, info: mock(), error: mock(), debug: mock() },
}));

mock.module("../secrets/secrets", () => ({
  secretsService: { getDecryptedValue: mockGetDecryptedValue },
}));

mock.module("./account-pool", () => ({
  TeamCredentialAccountPool: mock(() => ({
    select: mockSelect,
    markNeedsReauth: mockMarkNeedsReauth,
    markRateLimited: mockMarkRateLimited,
  })),
}));

mock.module("./pool-deps", () => ({
  DrizzleAccountPoolDeps: mock(() => ({
    isStale: () => true,
    refresh: mockRefresh,
    secretIdFor: mockSecretIdFor,
  })),
}));

mock.module("../../../db/repositories/pooled-credentials", () => ({
  pooledCredentialsRepository: {
    recordInferenceUse: mockRecordInferenceUse,
  },
}));

import type { TeamPoolRegistry } from "./registry";

const PARAMS = {
  organizationId: "org-1",
  providerId: "anthropic-api" as const,
};

async function freshRegistry(): Promise<TeamPoolRegistry> {
  mockSelect.mockReset();
  mockSecretIdFor.mockReset();
  mockGetDecryptedValue.mockReset();
  mockMarkNeedsReauth.mockReset();
  mockMarkNeedsReauth.mockResolvedValue(undefined);
  mockMarkRateLimited.mockReset();
  mockMarkRateLimited.mockResolvedValue(undefined);
  mockWarn.mockReset();
  mockRecordInferenceUse.mockClear();
  mockRefresh.mockClear();
  mockRefresh.mockResolvedValue(undefined);
  const { TeamPoolRegistry } = await import("./registry");
  return new TeamPoolRegistry();
}

describe("TeamPoolRegistry.selectCredential error policy", () => {
  it("returns null WITHOUT warning when the org has no eligible pooled credential (designed empty)", async () => {
    const registry = await freshRegistry();
    mockSelect.mockResolvedValue(null);

    const result = await registry.selectCredential(PARAMS);

    expect(result).toBeNull();
    // Designed-empty must not masquerade as a failure: no failure log.
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockGetDecryptedValue).not.toHaveBeenCalled();
  });

  it("surfaces an internal decrypt failure observably instead of silently swallowing it", async () => {
    const registry = await freshRegistry();
    mockSelect.mockResolvedValue({ id: "cred-1", label: "team-key" });
    mockSecretIdFor.mockReturnValue("secret-1");
    mockGetDecryptedValue.mockRejectedValue(new Error("vault decrypt failed"));

    const result = await registry.selectCredential(PARAMS);

    // J4 degrade to the platform-env path — but the failure is NOT hidden.
    expect(result).toBeNull();
    expect(mockGetDecryptedValue).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [message, context] = mockWarn.mock.calls[0];
    expect(message).toContain("[TeamPoolRegistry]");
    expect(context).toMatchObject({
      organizationId: "org-1",
      providerId: "anthropic-api",
      error: "vault decrypt failed",
    });
  });

  it("distinguishes empty from failure: empty is silent, failure warns — for the same null return", async () => {
    // Empty branch: no warn.
    const emptyRegistry = await freshRegistry();
    mockSelect.mockResolvedValue(null);
    expect(await emptyRegistry.selectCredential(PARAMS)).toBeNull();
    const warnsAfterEmpty = mockWarn.mock.calls.length;

    // Failure branch: exactly one warn, on an otherwise identical call shape.
    const failRegistry = await freshRegistry();
    mockSelect.mockResolvedValue({ id: "cred-1", label: "team-key" });
    mockSecretIdFor.mockReturnValue("secret-1");
    mockGetDecryptedValue.mockRejectedValue(new Error("db unavailable"));
    expect(await failRegistry.selectCredential(PARAMS)).toBeNull();

    expect(warnsAfterEmpty).toBe(0);
    expect(mockWarn.mock.calls.length).toBe(1);
  });

  it("returns the resolved credential on the happy path (no degrade, no warn)", async () => {
    const registry = await freshRegistry();
    mockSelect.mockResolvedValue({ id: "cred-1", label: "team-key" });
    mockSecretIdFor.mockReturnValue("secret-1");
    mockGetDecryptedValue.mockResolvedValue("sk-real-key");

    const result = await registry.selectCredential(PARAMS);

    expect(result).toEqual({
      credentialId: "cred-1",
      providerId: "anthropic-api",
      envKey: "ANTHROPIC_API_KEY",
      apiKey: "sk-real-key",
      label: "team-key",
    });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("reuses the decrypted key and forwards Worker background persistence", async () => {
    const registry = await freshRegistry();
    const defer = mock((_task: Promise<void>) => undefined);
    mockSelect.mockResolvedValue({ id: "cred-1", label: "team-key" });
    mockSecretIdFor.mockReturnValue("secret-1");
    mockGetDecryptedValue.mockResolvedValue("sk-real-key");

    await registry.selectCredential({ ...PARAMS, defer });
    await registry.selectCredential({ ...PARAMS, defer });

    expect(mockGetDecryptedValue).toHaveBeenCalledTimes(1);
    expect(mockGetDecryptedValue.mock.calls[0]?.[3]).toEqual({ defer });
  });
});

describe("TeamPoolRegistry.selectCredentialCacheOnly", () => {
  it("returns warming on a cold isolate and serves the hydrated secret from memory", async () => {
    const registry = await freshRegistry();
    mockSelect.mockResolvedValue({ id: "cred-1", label: "team-key" });
    mockSecretIdFor.mockReturnValue("secret-1");
    mockGetDecryptedValue.mockResolvedValue("sk-real-key");
    const background: Promise<unknown>[] = [];

    expect(
      await registry.selectCredentialCacheOnly(PARAMS, {
        executionCtx: { waitUntil: (promise) => background.push(promise) },
      }),
    ).toEqual({ kind: "warming" });
    expect(background).toHaveLength(1);
    await background[0];

    expect(await registry.selectCredentialCacheOnly(PARAMS)).toEqual({
      kind: "ready",
      credential: {
        credentialId: "cred-1",
        providerId: "anthropic-api",
        envKey: "ANTHROPIC_API_KEY",
        apiKey: "sk-real-key",
        label: "team-key",
      },
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockGetDecryptedValue).toHaveBeenCalledTimes(1);
  });

  it("does not query pool metadata or the secret store without waitUntil", async () => {
    const registry = await freshRegistry();

    expect(await registry.selectCredentialCacheOnly(PARAMS)).toEqual({
      kind: "unavailable",
    });
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGetDecryptedValue).not.toHaveBeenCalled();
  });

  it("negative-caches a legitimately empty pool and coalesces cold hydration", async () => {
    const registry = await freshRegistry();
    mockSelect.mockResolvedValue(null);
    const background: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    };

    expect(
      await Promise.all([
        registry.selectCredentialCacheOnly(PARAMS, { executionCtx }),
        registry.selectCredentialCacheOnly(PARAMS, { executionCtx }),
      ]),
    ).toEqual([{ kind: "warming" }, { kind: "warming" }]);
    expect(background).toHaveLength(2);
    expect(background[0]).toBe(background[1]);
    await background[0];
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(await registry.selectCredentialCacheOnly(PARAMS)).toEqual({
      kind: "ready",
      credential: null,
    });
  });

  it("does not let an in-flight hydration repopulate a mutated organization", async () => {
    const registry = await freshRegistry();
    mockSelect.mockResolvedValue({ id: "cred-1", label: "team-key" });
    mockSecretIdFor.mockReturnValue("secret-1");
    const secret = Promise.withResolvers<string>();
    mockGetDecryptedValue.mockReturnValue(secret.promise);
    const background: Promise<unknown>[] = [];

    expect(
      await registry.selectCredentialCacheOnly(PARAMS, {
        executionCtx: {
          waitUntil: (promise) => background.push(promise),
        },
      }),
    ).toEqual({ kind: "warming" });

    registry.invalidate(PARAMS.organizationId);
    secret.resolve("sk-stale-key");
    await Promise.all(background);

    expect(await registry.selectCredentialCacheOnly(PARAMS)).toEqual({
      kind: "unavailable",
    });
  });

  it("evicts every cached session selection after a provider auth failure", async () => {
    const registry = await freshRegistry();
    mockSelect.mockResolvedValue({ id: "cred-1", label: "team-key" });
    mockSecretIdFor.mockReturnValue("secret-1");
    mockGetDecryptedValue.mockResolvedValue("sk-real-key");
    const background: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    };
    const firstSession = { ...PARAMS, sessionKey: "session-1" };
    const secondSession = { ...PARAMS, sessionKey: "session-2" };

    await registry.selectCredentialCacheOnly(firstSession, { executionCtx });
    await registry.selectCredentialCacheOnly(secondSession, { executionCtx });
    await Promise.all(background);

    expect(await registry.selectCredentialCacheOnly(firstSession)).toMatchObject({ kind: "ready" });
    expect(await registry.selectCredentialCacheOnly(secondSession)).toMatchObject({
      kind: "ready",
    });

    await registry.recordProviderFailure({
      organizationId: PARAMS.organizationId,
      credentialId: "cred-1",
      providerId: PARAMS.providerId,
      status: 401,
    });

    expect(mockMarkNeedsReauth).toHaveBeenCalledTimes(1);
    expect(await registry.selectCredentialCacheOnly(firstSession)).toEqual({
      kind: "unavailable",
    });
    expect(await registry.selectCredentialCacheOnly(secondSession)).toEqual({
      kind: "unavailable",
    });
  });

  it("evicts rejected selections even when provider-health persistence fails", async () => {
    const registry = await freshRegistry();
    mockSelect.mockResolvedValue({ id: "cred-1", label: "team-key" });
    mockSecretIdFor.mockReturnValue("secret-1");
    mockGetDecryptedValue.mockResolvedValue("sk-real-key");
    const background: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    };
    const firstSession = { ...PARAMS, sessionKey: "session-1" };
    const secondSession = { ...PARAMS, sessionKey: "session-2" };

    await registry.selectCredentialCacheOnly(firstSession, { executionCtx });
    await registry.selectCredentialCacheOnly(secondSession, { executionCtx });
    await Promise.all(background);
    mockMarkNeedsReauth.mockRejectedValue(new Error("health write failed"));

    await registry.recordProviderFailure({
      organizationId: PARAMS.organizationId,
      credentialId: "cred-1",
      providerId: PARAMS.providerId,
      status: 401,
    });

    expect(await registry.selectCredentialCacheOnly(firstSession)).toEqual({
      kind: "unavailable",
    });
    expect(await registry.selectCredentialCacheOnly(secondSession)).toEqual({
      kind: "unavailable",
    });
    expect(mockWarn).toHaveBeenCalledWith(
      "[TeamPoolRegistry] provider failure writeback failed",
      expect.objectContaining({ error: "health write failed" }),
    );
  });

  it("retains usage attribution under waitUntil instead of joining it to output", async () => {
    const registry = await freshRegistry();
    const background: Promise<unknown>[] = [];

    registry.recordUseOffPath(
      {
        organizationId: "org-1",
        credentialId: "cred-1",
        userId: "user-1",
      },
      { waitUntil: (promise) => background.push(promise) },
    );

    expect(background).toHaveLength(1);
    await background[0];
    expect(mockRecordInferenceUse).toHaveBeenCalledTimes(1);
  });
});
