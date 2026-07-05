/**
 * Error-policy guard for DrizzleAccountPoolDeps: credential/DB failures must
 * fail closed (propagate), while genuinely-empty domain outcomes ("row deleted
 * underneath us", "no secret") stay distinguishable as designed no-ops. The
 * only swallowed path is the J6 best-effort vault-secret teardown after an
 * already-authoritative row delete. Deterministic in-memory mocks stand in for
 * the repository + secrets vault; the class under test is real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const repo = {
  listByOrganization: vi.fn(),
  updatePoolStateForOrganization: vi.fn(),
  deleteForOrganization: vi.fn(),
  findByIdForOrganization: vi.fn(),
};
const secrets = { delete: vi.fn() };
const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

vi.mock("../../../db/repositories/pooled-credentials", () => ({
  pooledCredentialsRepository: repo,
}));
vi.mock("../secrets/secrets", () => ({ secretsService: secrets }));
vi.mock("../../utils/logger", () => ({ logger: log }));

import type { PooledCredential } from "../../../db/repositories/pooled-credentials";
import { DrizzleAccountPoolDeps } from "./pool-deps";

const ORG = "org-1";

function makeRow(over: Partial<PooledCredential> = {}): PooledCredential {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: "cred-1",
    organization_id: ORG,
    provider: "anthropic-api",
    secret_id: "secret-1",
    label: "team key",
    key_last4: "abcd",
    contributed_by: "user-1",
    priority: 100,
    enabled: true,
    health: "ok",
    health_detail: null,
    usage: null,
    last_used_at: null,
    created_at: now,
    updated_at: now,
    ...over,
  } as PooledCredential;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DrizzleAccountPoolDeps.refresh (fail-closed load)", () => {
  it("propagates a DB read failure instead of serving an empty snapshot", async () => {
    repo.listByOrganization.mockRejectedValueOnce(new Error("db down"));
    const deps = new DrizzleAccountPoolDeps(ORG);
    await expect(deps.refresh()).rejects.toThrow("db down");
    // A failed load must NOT masquerade as "org has zero credentials".
    expect(Object.keys(deps.readAccounts())).toHaveLength(0);
  });

  it("serves the loaded rows on success", async () => {
    repo.listByOrganization.mockResolvedValueOnce([makeRow()]);
    const deps = new DrizzleAccountPoolDeps(ORG);
    await deps.refresh();
    expect(Object.keys(deps.readAccounts())).toHaveLength(1);
    expect(deps.secretIdFor("cred-1")).toBe("secret-1");
  });
});

describe("DrizzleAccountPoolDeps.writeAccount (fail-closed vs legit not-found)", () => {
  it("propagates a DB write failure rather than silently dropping the row", async () => {
    repo.listByOrganization.mockResolvedValueOnce([makeRow()]);
    const deps = new DrizzleAccountPoolDeps(ORG);
    await deps.refresh();
    const account = deps.readAccounts()["anthropic-api:cred-1"];
    expect(account).toBeDefined();

    repo.updatePoolStateForOrganization.mockRejectedValueOnce(new Error("update failed"));
    await expect(deps.writeAccount(account)).rejects.toThrow("update failed");
    // The credential is still present — a failed write is not a deletion.
    expect(deps.readAccounts()["anthropic-api:cred-1"]).toBeDefined();
  });

  it("treats an undefined update (row deleted underneath) as a designed drop, not a failure", async () => {
    repo.listByOrganization.mockResolvedValueOnce([makeRow()]);
    const deps = new DrizzleAccountPoolDeps(ORG);
    await deps.refresh();
    const account = deps.readAccounts()["anthropic-api:cred-1"];

    repo.updatePoolStateForOrganization.mockResolvedValueOnce(undefined);
    await expect(deps.writeAccount(account)).resolves.toBeUndefined();
    // Legit "row gone" empties this key WITHOUT throwing — distinct from the
    // DB-failure case above, which threw and kept the row.
    expect(deps.readAccounts()["anthropic-api:cred-1"]).toBeUndefined();
    expect(deps.secretIdFor("cred-1")).toBeNull();
  });
});

describe("DrizzleAccountPoolDeps.deleteAccount", () => {
  it("propagates a DB delete failure (the authoritative removal must fail closed)", async () => {
    repo.listByOrganization.mockResolvedValueOnce([makeRow()]);
    const deps = new DrizzleAccountPoolDeps(ORG);
    await deps.refresh();

    repo.deleteForOrganization.mockRejectedValueOnce(new Error("delete failed"));
    await expect(deps.deleteAccount("anthropic-api", "cred-1")).rejects.toThrow("delete failed");
    // Vault teardown never ran because the authoritative delete threw first.
    expect(secrets.delete).not.toHaveBeenCalled();
  });

  it("swallows only the J6 best-effort secret teardown after a successful row delete", async () => {
    repo.listByOrganization.mockResolvedValueOnce([makeRow()]);
    const deps = new DrizzleAccountPoolDeps(ORG);
    await deps.refresh();

    repo.deleteForOrganization.mockResolvedValueOnce(makeRow());
    secrets.delete.mockRejectedValueOnce(new Error("vault unavailable"));
    // Row delete succeeded → the credential is unselectable; an orphaned secret
    // is a GC concern, so this resolves rather than throwing.
    await expect(deps.deleteAccount("anthropic-api", "cred-1")).resolves.toBeUndefined();
    expect(deps.readAccounts()["anthropic-api:cred-1"]).toBeUndefined();
    expect(secrets.delete).toHaveBeenCalledTimes(1);
    // The swallowed teardown failure is surfaced observably as a warning.
    expect(log.warn).toHaveBeenCalledWith(
      "[DrizzleAccountPoolDeps] secret cleanup failed after credential delete",
      expect.objectContaining({ organizationId: ORG, credentialId: "cred-1" }),
    );
  });

  it("deletes the backing vault secret on the happy path", async () => {
    repo.listByOrganization.mockResolvedValueOnce([makeRow()]);
    const deps = new DrizzleAccountPoolDeps(ORG);
    await deps.refresh();

    repo.deleteForOrganization.mockResolvedValueOnce(makeRow());
    secrets.delete.mockResolvedValueOnce(undefined);
    await deps.deleteAccount("anthropic-api", "cred-1");
    expect(secrets.delete).toHaveBeenCalledWith("secret-1", ORG, {
      actorType: "system",
      actorId: "team-credential-pool",
      source: "team-credential-pool",
    });
    expect(log.warn).not.toHaveBeenCalled();
  });
});
