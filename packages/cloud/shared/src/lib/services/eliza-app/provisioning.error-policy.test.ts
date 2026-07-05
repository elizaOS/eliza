// Pins the fail-closed error policy of eliza-app provisioning: an internal
// provisioning failure must PROPAGATE (and the compensating teardown must never
// mask it), while a legitimately-drained org stays a distinguishable
// designed-empty `insufficient_credits` status rather than a thrown failure.
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import { containersEnv as actualContainersEnv } from "../../config/containers-env";
import { elizaSandboxService } from "../eliza-sandbox";

const listByOrganization = mock();
const createAgent = mock();
const enqueueAgentProvision = mock();
const deleteSandbox = mock();
const hasElizaAppInitialFreeCredits = mock();
const addCredits = mock();
const checkAgentCreditGate = mock();

const deleteSandboxSpy = spyOn(agentSandboxesRepository, "delete").mockImplementation(
  (...args) => deleteSandbox(...args) as never,
);

// Spread the real containersEnv so this process-global mock.module only overrides
// defaultAgentImage; bun's mock.module leaks across files in a single process.
mock.module("../../config/containers-env", () => ({
  containersEnv: {
    ...actualContainersEnv,
    defaultAgentImage: () => "ghcr.io/elizaos/eliza:stable",
  },
}));

const listByOrganizationSpy = spyOn(
  agentSandboxesRepository,
  "listByOrganization",
).mockImplementation((...args) => listByOrganization(...args) as never);

mock.module("../../../db/repositories/credit-transactions", () => ({
  creditTransactionsRepository: { hasElizaAppInitialFreeCredits },
}));

mock.module("../credits", () => ({
  creditsService: { addCredits },
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));

const createAgentSpy = spyOn(elizaSandboxService, "createAgent").mockImplementation(
  (...args) => createAgent(...args) as never,
);

mock.module("../provisioning-jobs", () => ({
  provisioningJobService: { enqueueAgentProvision },
}));

mock.module("../agent-billing-gate", () => ({ checkAgentCreditGate }));

afterAll(() => {
  listByOrganizationSpy.mockRestore();
  createAgentSpy.mockRestore();
  deleteSandboxSpy.mockRestore();
});

const { ensureElizaAppProvisioning } = await import(
  `./provisioning.ts?test=provisioning-error-policy-${Date.now()}`
);

describe("ensureElizaAppProvisioning error policy", () => {
  beforeEach(() => {
    listByOrganization.mockReset();
    createAgent.mockReset();
    enqueueAgentProvision.mockReset();
    deleteSandbox.mockReset();
    hasElizaAppInitialFreeCredits.mockReset();
    addCredits.mockReset();
    checkAgentCreditGate.mockReset();
  });

  test("propagates the real enqueue failure even when the compensating delete ALSO fails (teardown never masks the cause)", async () => {
    hasElizaAppInitialFreeCredits.mockResolvedValue(true);
    listByOrganization.mockResolvedValue([]);
    checkAgentCreditGate.mockResolvedValue({ allowed: true, balance: 5 });
    createAgent.mockResolvedValue({
      agent: { id: "agent-1", status: "pending", bridge_url: null },
      idempotent: false,
    });
    // The enqueue is the primary failure the caller must see.
    enqueueAgentProvision.mockRejectedValue(new Error("queue down"));
    // The compensating teardown itself fails — it must NOT swallow or replace the
    // original enqueue error.
    deleteSandbox.mockRejectedValue(new Error("db connection reset"));

    await expect(
      ensureElizaAppProvisioning({ organizationId: "org-1", userId: "user-1" }),
    ).rejects.toThrow("queue down");

    // The teardown was still attempted (best-effort), and provisioning did not
    // fabricate a healthy status from the failure.
    expect(deleteSandbox).toHaveBeenCalledWith("agent-1", "org-1");
  });

  test("still propagates enqueue failure and deletes the orphan when the teardown succeeds", async () => {
    hasElizaAppInitialFreeCredits.mockResolvedValue(true);
    listByOrganization.mockResolvedValue([]);
    checkAgentCreditGate.mockResolvedValue({ allowed: true, balance: 5 });
    createAgent.mockResolvedValue({
      agent: { id: "agent-1", status: "pending", bridge_url: null },
      idempotent: false,
    });
    enqueueAgentProvision.mockRejectedValue(new Error("queue down"));
    deleteSandbox.mockResolvedValue(true);

    await expect(
      ensureElizaAppProvisioning({ organizationId: "org-1", userId: "user-1" }),
    ).rejects.toThrow("queue down");
    expect(deleteSandbox).toHaveBeenCalledWith("agent-1", "org-1");
  });

  test("designed-empty stays distinct from failure: a drained org returns insufficient_credits, never throws and never provisions", async () => {
    hasElizaAppInitialFreeCredits.mockResolvedValue(true);
    listByOrganization.mockResolvedValue([]);
    checkAgentCreditGate.mockResolvedValue({ allowed: false, balance: 0 });

    const result = await ensureElizaAppProvisioning({
      organizationId: "org-1",
      userId: "user-1",
    });

    // A legitimately-drained org is NOT an internal failure: it is a distinguishable
    // status, not a thrown error and not fabricated provisioning.
    expect(result).toEqual({
      status: "insufficient_credits",
      agentId: null,
      bridgeUrl: null,
      sandbox: null,
    });
    expect(createAgent).not.toHaveBeenCalled();
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
  });

  test("an internal repository failure while reading status PROPAGATES (not swallowed to a healthy-empty status)", async () => {
    // A DB read failure must surface as a throw, never degrade to status:"none"
    // (which would look like a legitimately un-provisioned org).
    hasElizaAppInitialFreeCredits.mockResolvedValue(true);
    listByOrganization.mockRejectedValue(new Error("sandbox lookup failed"));

    await expect(
      ensureElizaAppProvisioning({ organizationId: "org-1", userId: "user-1" }),
    ).rejects.toThrow("sandbox lookup failed");
    expect(createAgent).not.toHaveBeenCalled();
  });
});
