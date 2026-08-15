/**
 * Deterministic coverage for the account-limits snapshot assembly (#19777).
 * The system under test is the real DTO builder; the injected sources are the
 * seam the route wires, so each case drives genuine classification, failure
 * isolation, and serialization logic — no snapshot field is hand-assembled.
 */
import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { DrizzleQueryError } from "drizzle-orm";
import { type AccountLimitsSources, buildAccountLimitsSnapshot } from "./account-limits-snapshot";

const GIB_5 = 5n * 1024n * 1024n * 1024n;

function healthySources(overrides: Partial<AccountLimitsSources> = {}): AccountLimitsSources {
  return {
    orgBilling: async () => ({ creditBalance: 15, settings: {} }),
    cloudCharacterCount: async () => 3,
    sandboxQuotaCount: async () => 2,
    containerQuota: async () => ({ current: 1, max: 10 }),
    appCount: async () => 4,
    appLimit: async () => 25,
    storageQuota: async () => ({ bytesUsed: 123n, bytesLimit: GIB_5 }),
    inferenceRateTier: async () => ({ completionsRpm: 60, embeddingsRpm: 120 }),
    maxCloudCharacters: (balance, settings) => {
      const custom = (settings as { max_agents?: number } | undefined)?.max_agents;
      if (custom && custom > 0) return custom;
      return balance >= 10 ? 100 : 5;
    },
    maxNonTerminalAgents: (balance) => ((balance ?? 0) >= 10 ? 100 : 5),
    defaultStorageBytesLimit: GIB_5,
    ...overrides,
  };
}

describe("buildAccountLimitsSnapshot", () => {
  test("healthy org reports every enforced ceiling with its source and one timestamp", async () => {
    const snapshot = await buildAccountLimitsSnapshot(healthySources());

    expect(new Date(snapshot.observedAt).toISOString()).toBe(snapshot.observedAt);
    expect(snapshot.cloudCharacters).toEqual({
      source: "cloud-character-quota",
      state: "available",
      used: 3,
      limit: 100,
    });
    expect(snapshot.agentSandboxes).toEqual({
      source: "agent-sandbox-quota",
      used: 2,
      nonEagerCreate: { state: "available", limit: 5 },
      eagerManagedCreate: { state: "available", limit: 100 },
      state: "available",
      nonEagerCreateLimit: 5,
      eagerManagedCreateLimit: 100,
    });
    expect(snapshot.containers).toEqual({
      source: "container-quota",
      state: "available",
      used: 1,
      limit: 10,
    });
    expect(snapshot.apps).toEqual({
      source: "apps-service",
      state: "available",
      used: 4,
      limit: 25,
    });
    expect(snapshot.storage).toEqual({
      source: "org-storage-quota",
      state: "available",
      bytesUsed: "123",
      bytesLimit: GIB_5.toString(),
    });
    expect(snapshot.inferenceRateLimits).toEqual({
      source: "org-rate-limits",
      state: "available",
      completionsRpm: 60,
      embeddingsRpm: 120,
    });
    // No misleading create decision is exposed.
    expect("canCreate" in (snapshot.agentSandboxes as Record<string, unknown>)).toBe(false);
  });

  test("classifies at-limit and over-limit exactly", async () => {
    const snapshot = await buildAccountLimitsSnapshot(
      healthySources({
        cloudCharacterCount: async () => 100,
        sandboxQuotaCount: async () => 5,
        containerQuota: async () => ({ current: 11, max: 10 }),
        appCount: async () => 26,
      }),
    );
    expect(snapshot.cloudCharacters.state).toBe("at-limit");
    expect(snapshot.agentSandboxes.nonEagerCreate.state).toBe("at-limit");
    expect(snapshot.agentSandboxes.eagerManagedCreate.state).toBe("available");
    expect(snapshot.containers.state).toBe("over-limit");
    expect(snapshot.apps.state).toBe("over-limit");
  });

  test("org settings override raises the character ceiling through the canonical helper", async () => {
    const snapshot = await buildAccountLimitsSnapshot(
      healthySources({
        orgBilling: async () => ({
          creditBalance: 0,
          settings: { max_agents: 7 },
        }),
      }),
    );
    expect(snapshot.cloudCharacters.limit).toBe(7);
    // The sandbox ceiling ignores the character override and follows balance.
    expect(snapshot.agentSandboxes.nonEagerCreate.limit).toBe(5);
  });

  test("a missing storage row maps only to the schema default with zero usage", async () => {
    const snapshot = await buildAccountLimitsSnapshot(
      healthySources({ storageQuota: async () => null }),
    );
    expect(snapshot.storage).toEqual({
      source: "org-storage-quota",
      state: "available",
      bytesUsed: "0",
      bytesLimit: GIB_5.toString(),
    });
  });

  test("storage bytes stay exact decimal strings past Number precision", async () => {
    const big = 9_007_199_254_740_993n; // Number.MAX_SAFE_INTEGER + 2
    const snapshot = await buildAccountLimitsSnapshot(
      healthySources({
        storageQuota: async () => ({ bytesUsed: big, bytesLimit: big + 1n }),
      }),
    );
    expect(snapshot.storage.bytesUsed).toBe("9007199254740993");
    expect(snapshot.storage.bytesLimit).toBe("9007199254740994");
    expect(snapshot.storage.state).toBe("available");
  });

  test("a failed source becomes unavailable without poisoning its siblings", async () => {
    const snapshot = await buildAccountLimitsSnapshot(
      healthySources({
        containerQuota: async () => {
          throw new DrizzleQueryError("select container quota", [], new Error("offline"));
        },
      }),
    );
    expect(snapshot.containers).toEqual({
      source: "container-quota",
      state: "unavailable",
      reason: "source read failed",
    });
    expect(snapshot.cloudCharacters.state).toBe("available");
    expect(snapshot.apps.state).toBe("available");
    expect(snapshot.storage.state).toBe("available");
    expect(snapshot.inferenceRateLimits.state).toBe("available");
  });

  test("a container source failure is unavailable rather than a fabricated zero cap", async () => {
    const snapshot = await buildAccountLimitsSnapshot(
      healthySources({
        containerQuota: async () => ({
          current: 4,
          max: 0,
          sourceUnavailable: true,
        }),
      }),
    );

    expect(snapshot.containers).toEqual({
      source: "container-quota",
      state: "unavailable",
      reason: "container quota source is unavailable",
    });
  });

  test("an unreadable org row marks only balance-derived ceilings unavailable, never free-tier", async () => {
    const snapshot = await buildAccountLimitsSnapshot(
      healthySources({
        orgBilling: async () => {
          throw new ElizaError("Organization source unavailable", {
            code: "ACCOUNT_LIMIT_SOURCE_UNAVAILABLE",
            severity: "fatal",
          });
        },
      }),
    );
    expect(snapshot.cloudCharacters.state).toBe("unavailable");
    expect(snapshot.cloudCharacters.limit).toBeUndefined();
    expect(snapshot.agentSandboxes.used).toBe(2);
    expect(snapshot.agentSandboxes.nonEagerCreate).toEqual({ state: "available", limit: 5 });
    expect(snapshot.agentSandboxes.eagerManagedCreate).toEqual({
      state: "unavailable",
      reason: "source read failed",
    });
    // Sources that do not need the balance still report.
    expect(snapshot.containers.state).toBe("available");
    expect(snapshot.storage.state).toBe("available");
  });

  test("corrupt numeric data is unavailable, never a healthy zero", async () => {
    const snapshot = await buildAccountLimitsSnapshot(
      healthySources({
        cloudCharacterCount: async () => Number.NaN,
        orgBilling: async () => ({
          creditBalance: Number.NaN,
          settings: {},
        }),
        containerQuota: async () => ({ current: -1, max: 10 }),
        inferenceRateTier: async () => ({
          completionsRpm: Number.POSITIVE_INFINITY,
          embeddingsRpm: 120,
        }),
        storageQuota: async () =>
          ({ bytesUsed: 5, bytesLimit: GIB_5 }) as unknown as {
            bytesUsed: bigint;
            bytesLimit: bigint;
          },
      }),
    );
    expect(snapshot.cloudCharacters.state).toBe("unavailable");
    expect(snapshot.agentSandboxes.nonEagerCreate.state).toBe("available");
    expect(snapshot.agentSandboxes.eagerManagedCreate.state).toBe("unavailable");
    expect(snapshot.containers.state).toBe("unavailable");
    expect(snapshot.inferenceRateLimits.state).toBe("unavailable");
    expect(snapshot.storage.state).toBe("unavailable");
    for (const item of [snapshot.cloudCharacters, snapshot.containers, snapshot.storage]) {
      expect(item.used ?? undefined).toBeUndefined();
      expect((item as { reason?: string }).reason).toBeTruthy();
    }
  });

  test("corrupt derived ceilings and negative storage bytes fail visibly", async () => {
    const snapshot = await buildAccountLimitsSnapshot(
      healthySources({
        maxCloudCharacters: () => Number.NaN,
        maxNonTerminalAgents: () => 1.5,
        storageQuota: async () => ({ bytesUsed: -1n, bytesLimit: GIB_5 }),
      }),
    );

    expect(snapshot.cloudCharacters).toMatchObject({
      state: "unavailable",
      reason: "cloud character limit is not a usable positive integer",
    });
    expect(snapshot.agentSandboxes.nonEagerCreate).toEqual({
      state: "unavailable",
      reason: "non-eager sandbox limit is not a usable positive integer",
    });
    expect(snapshot.agentSandboxes.eagerManagedCreate).toEqual({
      state: "unavailable",
      reason: "eager sandbox limit is not a usable positive integer",
    });
    expect(snapshot.storage).toMatchObject({
      state: "unavailable",
      reason: "storage quota row returned negative bytes",
    });
  });

  test("rate limits expose configured completions/embeddings caps only", async () => {
    const snapshot = await buildAccountLimitsSnapshot(healthySources());
    expect(Object.keys(snapshot.inferenceRateLimits).sort()).toEqual([
      "completionsRpm",
      "embeddingsRpm",
      "source",
      "state",
    ]);
  });

  test("unexpected implementation defects escape instead of becoming a successful snapshot", async () => {
    await expect(
      buildAccountLimitsSnapshot(
        healthySources({
          cloudCharacterCount: async () => {
            throw new TypeError("programming defect");
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
