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
const mockWarn = mock();

mock.module("../../utils/logger", () => ({
  logger: { warn: mockWarn, info: mock(), error: mock(), debug: mock() },
}));

mock.module("../secrets/secrets", () => ({
  secretsService: { getDecryptedValue: mockGetDecryptedValue },
}));

mock.module("./account-pool", () => ({
  TeamCredentialAccountPool: mock(() => ({ select: mockSelect })),
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
    recordDailyUsage: mock(),
    updatePoolStateForOrganization: mock(),
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
  mockWarn.mockReset();
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
});
