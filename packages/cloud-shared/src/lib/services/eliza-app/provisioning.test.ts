import { beforeEach, describe, expect, mock, test } from "bun:test";

const listByOrganization = mock();
const createAgent = mock();
const enqueueAgentProvision = mock();
const hasElizaAppInitialFreeCredits = mock();
const addCredits = mock();

mock.module("../../../db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    listByOrganization,
  },
}));

mock.module("../../../db/repositories/credit-transactions", () => ({
  creditTransactionsRepository: {
    hasElizaAppInitialFreeCredits,
  },
}));

mock.module("../credits", () => ({
  creditsService: {
    addCredits,
  },
}));

mock.module("../eliza-sandbox", () => ({
  elizaSandboxService: {
    createAgent,
  },
}));

mock.module("../provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentProvision,
  },
}));

const { ensureElizaAppProvisioning } = await import("./provisioning.ts?test=provisioning");

describe("ensureElizaAppProvisioning", () => {
  beforeEach(() => {
    listByOrganization.mockReset();
    createAgent.mockReset();
    enqueueAgentProvision.mockReset();
    hasElizaAppInitialFreeCredits.mockReset();
    addCredits.mockReset();
  });

  test("grants starter credits before provisioning a new Eliza App agent", async () => {
    hasElizaAppInitialFreeCredits.mockResolvedValue(false);
    listByOrganization.mockResolvedValue([]);
    addCredits.mockResolvedValue({
      transaction: { id: "credit-tx-1" },
      newBalance: 5,
    });
    createAgent.mockResolvedValue({
      id: "agent-1",
      status: "provisioning",
      bridge_url: null,
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
    expect(createAgent).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      agentName: "Eliza",
      dockerImage: "elizaos/eliza:latest",
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
    expect(result).toMatchObject({
      status: "running",
      agentId: "agent-1",
      bridgeUrl: "https://agent.example",
    });
  });
});
