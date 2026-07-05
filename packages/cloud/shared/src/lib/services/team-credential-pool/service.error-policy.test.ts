/**
 * Error-policy proof for the team credential pool use-cases: an internal
 * failure (DB / vault throwing) must PROPAGATE fail-closed, and must stay
 * distinguishable from a legitimately-empty domain result (no rows / not
 * found). Deterministic — every collaborator is a bun mock; no live DB or
 * provider. Guards #13415: catches here compensate/teardown, they never
 * swallow a failure into a fabricated success or default.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

// bun's mock.module is not hoisted the way vitest's vi.mock is: the factories
// must be registered before the module under test is imported. So the shared
// collaborator mocks are declared here, registered via mock.module, and the
// service is pulled in with a dynamic import() inside each test.
const repo = {
  create: mock(),
  listByOrganizationWithContributor: mock(),
  usageTotalsForDay: mock(),
  deleteForOrganization: mock(),
};
const secrets = {
  create: mock(async () => ({ id: "secret-1" })),
  delete: mock(async () => undefined),
};
const probe = mock(async () => ({ ok: true, status: 200, latencyMs: 1 }));
const registryInvalidate = mock();

mock.module("../../../db/repositories/pooled-credentials", () => ({
  pooledCredentialsRepository: repo,
}));

mock.module("../secrets/secrets", () => ({
  secretsService: secrets,
}));

mock.module("./probe", () => ({
  probePooledApiKey: probe,
}));

mock.module("./registry", () => ({
  getTeamPoolRegistry: () => ({ invalidate: registryInvalidate }),
}));

mock.module("../../utils/logger", () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}));

// provider-map is intentionally NOT mocked — the real provider validation runs.
async function loadService() {
  return import("./service");
}

const audit = { actorType: "user", actorId: "u1", source: "test" } as never;

const baseContribute = {
  organizationId: "org-1",
  userId: "u1",
  provider: "anthropic-api",
  apiKey: "sk-ant-0123456789",
  audit,
};

beforeEach(() => {
  repo.create.mockReset();
  repo.listByOrganizationWithContributor.mockReset();
  repo.usageTotalsForDay.mockReset();
  repo.deleteForOrganization.mockReset();
  secrets.create.mockReset();
  secrets.delete.mockReset();
  probe.mockReset();
  registryInvalidate.mockReset();

  probe.mockResolvedValue({ ok: true, status: 200, latencyMs: 1 });
  secrets.create.mockResolvedValue({ id: "secret-1" });
  secrets.delete.mockResolvedValue(undefined);
});

describe("contributePooledCredential — internal failure fails closed", () => {
  it("propagates a pool-row insert failure instead of swallowing it, and compensates the vault secret", async () => {
    const { contributePooledCredential } = await loadService();
    const insertError = new Error("pooled_credentials insert failed");
    repo.create.mockRejectedValueOnce(insertError);

    await expect(contributePooledCredential(baseContribute)).rejects.toBe(insertError);

    // Fail-closed: the just-created vault secret is torn down, not stranded.
    expect(secrets.delete).toHaveBeenCalledWith("secret-1", "org-1", audit);
  });

  it("does not let a best-effort cleanup failure mask the original insert failure", async () => {
    const { contributePooledCredential } = await loadService();
    const insertError = new Error("pooled_credentials insert failed");
    repo.create.mockRejectedValueOnce(insertError);
    secrets.delete.mockRejectedValueOnce(new Error("vault delete also failed"));

    // The ORIGINAL failure surfaces — the J6 teardown catch does not replace it.
    await expect(contributePooledCredential(baseContribute)).rejects.toBe(insertError);
  });
});

describe("removePooledCredential — not-found vs internal failure are distinguishable", () => {
  it("returns a designed 404 for a legitimately-missing credential", async () => {
    const { removePooledCredential, TeamCredentialPoolError } = await loadService();
    repo.deleteForOrganization.mockResolvedValue(undefined);

    await expect(
      removePooledCredential({ credentialId: "c1", organizationId: "org-1", audit }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      removePooledCredential({ credentialId: "c1", organizationId: "org-1", audit }),
    ).rejects.toBeInstanceOf(TeamCredentialPoolError);
  });

  it("propagates a raw DB failure rather than masking it as a 404", async () => {
    const { removePooledCredential, TeamCredentialPoolError } = await loadService();
    const dbError = new Error("connection reset");
    repo.deleteForOrganization.mockRejectedValueOnce(dbError);

    const rejection = removePooledCredential({
      credentialId: "c1",
      organizationId: "org-1",
      audit,
    });
    await expect(rejection).rejects.toBe(dbError);
    // Distinct from the not-found path: this is NOT a 404 TeamCredentialPoolError.
    await expect(rejection).rejects.not.toBeInstanceOf(TeamCredentialPoolError);
  });
});

describe("listPooledCredentials — empty result vs internal failure are distinguishable", () => {
  it("returns an empty list for an org with no pooled credentials", async () => {
    const { listPooledCredentials } = await loadService();
    repo.listByOrganizationWithContributor.mockResolvedValueOnce([]);
    repo.usageTotalsForDay.mockResolvedValueOnce(new Map());

    await expect(listPooledCredentials("org-1")).resolves.toEqual([]);
  });

  it("propagates a query failure instead of returning an empty list", async () => {
    const { listPooledCredentials } = await loadService();
    const queryError = new Error("select failed");
    repo.listByOrganizationWithContributor.mockRejectedValueOnce(queryError);
    repo.usageTotalsForDay.mockResolvedValueOnce(new Map());

    await expect(listPooledCredentials("org-1")).rejects.toBe(queryError);
  });
});
