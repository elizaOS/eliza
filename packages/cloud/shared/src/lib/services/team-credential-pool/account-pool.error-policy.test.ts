/**
 * Error-policy proof for the cloud team-credential account-pool brain: an
 * internal dependency failure (readAccounts / writeAccount throwing) must
 * PROPAGATE out of the pool, while a legitimately-empty snapshot or an absent
 * credential returns the pool's designed empty/no-op result. The two must be
 * distinguishable — a broken pipeline must never read as "no eligible account".
 * Deterministic in-memory deps (the injected seam), no DB.
 */
import type { LinkedAccountConfig } from "@elizaos/contracts";
import { describe, expect, it, vi } from "vitest";
import { TeamCredentialAccountPool } from "./account-pool";
import type { AccountPoolDeps } from "./account-pool-contract";

function makeAccount(overrides: Partial<LinkedAccountConfig> = {}): LinkedAccountConfig {
  return {
    id: "acc-1",
    providerId: "anthropic-api",
    label: "team key",
    source: "api-key",
    enabled: true,
    priority: 0,
    createdAt: 1,
    health: "ok",
    ...overrides,
  };
}

function poolWith(
  accounts: Record<string, LinkedAccountConfig>,
  writeAccount: AccountPoolDeps["writeAccount"] = vi.fn(async () => {}),
): { pool: TeamCredentialAccountPool; writeAccount: AccountPoolDeps["writeAccount"] } {
  const deps: AccountPoolDeps = {
    readAccounts: () => accounts,
    writeAccount,
  };
  return { pool: new TeamCredentialAccountPool(deps), writeAccount };
}

describe("TeamCredentialAccountPool error policy — fail closed on dep failure", () => {
  it("PROPAGATES a readAccounts failure out of select() (does not swallow to null)", async () => {
    const boom = new Error("decrypt/DB snapshot read failed");
    const deps: AccountPoolDeps = {
      readAccounts: () => {
        throw boom;
      },
      writeAccount: vi.fn(async () => {}),
    };
    const pool = new TeamCredentialAccountPool(deps);

    await expect(pool.select({ providerId: "anthropic-api" })).rejects.toThrow(boom);
  });

  it("returns null for a legitimately-empty snapshot (designed empty, NOT a failure)", async () => {
    const { pool } = poolWith({});
    await expect(pool.select({ providerId: "anthropic-api" })).resolves.toBeNull();
  });

  it("returns null when accounts exist but none are eligible (designed empty)", async () => {
    const { pool } = poolWith({
      "anthropic-api:acc-1": makeAccount({ enabled: false }),
    });
    await expect(pool.select({ providerId: "anthropic-api" })).resolves.toBeNull();
  });

  it("selects the eligible account on the happy path (distinguishes success from empty)", async () => {
    const account = makeAccount();
    const { pool } = poolWith({ "anthropic-api:acc-1": account });
    const picked = await pool.select({ providerId: "anthropic-api" });
    expect(picked?.id).toBe("acc-1");
  });

  it("distinguishes failure from empty: same call, thrown read vs empty read differ", async () => {
    const failing = new TeamCredentialAccountPool({
      readAccounts: () => {
        throw new Error("snapshot unavailable");
      },
      writeAccount: vi.fn(async () => {}),
    });
    const { pool: empty } = poolWith({});

    await expect(failing.select({ providerId: "anthropic-api" })).rejects.toThrow();
    await expect(empty.select({ providerId: "anthropic-api" })).resolves.toBeNull();
  });
});

describe("TeamCredentialAccountPool error policy — health writeback", () => {
  it("PROPAGATES a writeAccount failure out of markRateLimited (fail closed on the write path)", async () => {
    const writeBoom = new Error("pooled_credentials update failed");
    const { pool } = poolWith(
      { "anthropic-api:acc-1": makeAccount() },
      vi.fn(async () => {
        throw writeBoom;
      }),
    );

    await expect(
      pool.markRateLimited("acc-1", Date.now() + 60_000, "429", { providerId: "anthropic-api" }),
    ).rejects.toThrow(writeBoom);
  });

  it("markRateLimited for an absent credential is a silent no-op (not-found ≠ write failure)", async () => {
    const writeAccount = vi.fn(async () => {});
    const { pool } = poolWith({ "anthropic-api:acc-1": makeAccount() }, writeAccount);

    await expect(
      pool.markRateLimited("does-not-exist", Date.now() + 60_000, "429", {
        providerId: "anthropic-api",
      }),
    ).resolves.toBeUndefined();
    expect(writeAccount).not.toHaveBeenCalled();
  });

  it("markRateLimited writes health for a found credential (distinguishes no-op from real write)", async () => {
    const writeAccount = vi.fn(async () => {});
    const { pool } = poolWith({ "anthropic-api:acc-1": makeAccount() }, writeAccount);

    await pool.markRateLimited("acc-1", Date.now() + 60_000, "429", {
      providerId: "anthropic-api",
    });
    expect(writeAccount).toHaveBeenCalledTimes(1);
    const written = writeAccount.mock.calls[0]?.[0] as LinkedAccountConfig;
    expect(written.health).toBe("rate-limited");
  });
});
