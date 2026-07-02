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

// Spread the real containersEnv so this process-global mock.module only
// overrides defaultAgentImage. bun's mock.module leaks across files in a
// single test process; a partial object would make every other method
// (appsPublicBaseDomain, defaultHcloudServerType, …) undefined for whichever
// file happens to import after this one (order varies by platform → Windows).
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
  creditTransactionsRepository: {
    hasElizaAppInitialFreeCredits,
  },
}));

class InsufficientCreditsError extends Error {
  constructor(
    public readonly required: number,
    public readonly available: number,
    public readonly reason?: string,
  ) {
    super(
      `Insufficient credits. Required: $${required.toFixed(4)}, Available: $${available.toFixed(4)}`,
    );
    this.name = "InsufficientCreditsError";
  }
}

class CreditsService {}

mock.module("../credits", () => ({
  creditsService: {
    addCredits,
  },
  CreditsService,
  InsufficientCreditsError,
  COST_BUFFER: 1.5,
  MIN_RESERVATION: 0.000001,
  EPSILON: 0.0000001,
  DEFAULT_OUTPUT_TOKENS: 500,
}));

const createAgentSpy = spyOn(elizaSandboxService, "createAgent").mockImplementation(
  (...args) => createAgent(...args) as never,
);

mock.module("../provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentProvision,
  },
}));

mock.module("../agent-billing-gate", () => ({
  checkAgentCreditGate,
}));

afterAll(() => {
  listByOrganizationSpy.mockRestore();
  createAgentSpy.mockRestore();
  deleteSandboxSpy.mockRestore();
});

const { ensureElizaAppProvisioning } = await import(
  `./provisioning.ts?test=provisioning-${Date.now()}`
);

describe("ensureElizaAppProvisioning", () => {
  beforeEach(() => {
    listByOrganization.mockReset();
    createAgent.mockReset();
    enqueueAgentProvision.mockReset();
    deleteSandbox.mockReset();
    hasElizaAppInitialFreeCredits.mockReset();
    addCredits.mockReset();
    checkAgentCreditGate.mockReset();
  });

  test("grants starter credits before provisioning a new Eliza App agent", async () => {
    hasElizaAppInitialFreeCredits.mockResolvedValue(false);
    listByOrganization.mockResolvedValue([]);
    addCredits.mockResolvedValue({
      transaction: { id: "credit-tx-1" },
      newBalance: 5,
    });
    checkAgentCreditGate.mockResolvedValue({ allowed: true, balance: 5 });
    createAgent.mockResolvedValue({
      agent: { id: "agent-1", status: "provisioning", bridge_url: null },
      idempotent: false,
    });

    const result = await ensureElizaAppProvisioning({
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(hasElizaAppInitialFreeCredits).toHaveBeenCalledWith("org-1");
    expect(addCredits).toHaveBeenCalledWith({
      organizationId: "org-1",
      amount: 5,
      description: "Eliza App - Welcome bonus",
      metadata: {
        type: "initial_free_credits",
        source: "eliza-app-onboarding",
        userId: "user-1",
      },
      stripePaymentIntentId: "eliza-app-initial-free-credits:org-1",
    });
    // Fresh org: the starter grant lands before the gate runs, so the gate
    // sees the $5 balance and provisioning proceeds.
    expect(checkAgentCreditGate).toHaveBeenCalledWith("org-1");
    expect(createAgent).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      agentName: "Eliza",
      dockerImage: "ghcr.io/elizaos/eliza:stable",
      reuseExistingNonTerminal: true,
    });
    expect(enqueueAgentProvision).toHaveBeenCalledWith({
      agentId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
      agentName: "Eliza",
    });
    expect(result).toMatchObject({
      status: "provisioning",
      agentId: "agent-1",
      bridgeUrl: null,
    });
  });

  test("reuses an in-flight sandbox without enqueuing a second provision job", async () => {
    hasElizaAppInitialFreeCredits.mockResolvedValue(true);
    listByOrganization.mockResolvedValue([]);
    checkAgentCreditGate.mockResolvedValue({ allowed: true, balance: 5 });
    createAgent.mockResolvedValue({
      agent: { id: "agent-1", status: "provisioning", bridge_url: null },
      idempotent: true,
    });

    const result = await ensureElizaAppProvisioning({
      organizationId: "org-1",
      userId: "user-1",
    });

    // The org-scoped guard already had an agent + its job in flight, so a retry
    // must not mint a second job.
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "provisioning",
      agentId: "agent-1",
    });
  });

  test("deletes the just-created sandbox when the provision enqueue throws", async () => {
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

    // A throw between the insert-commit and the enqueue would otherwise strand a
    // job-less `pending` row the reuse guard then hands back forever — so the
    // orphan is deleted, letting a retry mint a fresh agent + job.
    expect(deleteSandbox).toHaveBeenCalledWith("agent-1", "org-1");
  });

  test("does not grant duplicate starter credits when an existing transaction is present", async () => {
    hasElizaAppInitialFreeCredits.mockResolvedValue(true);
    listByOrganization.mockResolvedValue([
      {
        id: "agent-1",
        status: "running",
        bridge_url: "https://agent.example",
      },
    ]);

    const result = await ensureElizaAppProvisioning({
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(addCredits).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
    // The existing-sandbox early return sits before the credit gate, so a
    // drained org with a live sandbox still gets it back untouched.
    expect(checkAgentCreditGate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "running",
      agentId: "agent-1",
      bridgeUrl: "https://agent.example",
    });
  });

  test("returns insufficient_credits without provisioning when a drained org fails the credit gate", async () => {
    // Returning drained org: the one-time starter grant was already consumed,
    // so ensureElizaAppStarterCredits is a no-op and the gate sees the real
    // (empty) balance.
    hasElizaAppInitialFreeCredits.mockResolvedValue(true);
    listByOrganization.mockResolvedValue([]);
    checkAgentCreditGate.mockResolvedValue({
      allowed: false,
      balance: 0.05,
      error:
        "Insufficient credits. A balance greater than $0.10 is required to create or run Eliza agents.",
    });

    const result = await ensureElizaAppProvisioning({
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(checkAgentCreditGate).toHaveBeenCalledWith("org-1");
    expect(addCredits).not.toHaveBeenCalled();
    // The denial must return a status, not throw — runOnboardingChat has no
    // enclosing try/catch, so a throwing gate would 500 the onboarding turn.
    expect(createAgent).not.toHaveBeenCalled();
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "insufficient_credits",
      agentId: null,
      bridgeUrl: null,
      sandbox: null,
    });
  });
});
