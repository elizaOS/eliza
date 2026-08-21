// Exercises provisioning behavior with deterministic cloud-shared lib fixtures.
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import { jobsRepository } from "../../../db/repositories/jobs";
import { ApiError } from "../../api/cloud-worker-errors";
import { containersEnv as actualContainersEnv } from "../../config/containers-env";
import { elizaSandboxService } from "../eliza-sandbox";

const listByOrganization = mock();
const createAgent = mock();
const enqueueAgentProvision = mock();
const deleteSandbox = mock();
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

const findLatestAgentLifecycleJob = mock();
const findLatestAgentLifecycleJobSpy = spyOn(
  jobsRepository,
  "findLatestAgentLifecycleJob",
).mockImplementation((...args) => findLatestAgentLifecycleJob(...args) as never);

afterAll(() => {
  listByOrganizationSpy.mockRestore();
  createAgentSpy.mockRestore();
  deleteSandboxSpy.mockRestore();
  findLatestAgentLifecycleJobSpy.mockRestore();
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
    checkAgentCreditGate.mockReset();
    findLatestAgentLifecycleJob.mockReset();
  });

  test("checks paid credit before provisioning a new Eliza App agent", async () => {
    listByOrganization.mockResolvedValue([]);
    checkAgentCreditGate.mockResolvedValue({ allowed: true, balance: 5 });
    createAgent.mockResolvedValue({
      agent: { id: "agent-1", status: "provisioning", bridge_url: null },
      idempotent: false,
    });

    const result = await ensureElizaAppProvisioning({
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(checkAgentCreditGate).toHaveBeenCalledWith("org-1");
    expect(createAgent).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      agentName: "Eliza",
      dockerImage: "ghcr.io/elizaos/eliza:stable",
      reuseExistingNonTerminal: true,
      maxNonTerminalAgents: 20,
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

  test("returns an existing running sandbox without consulting the credit gate", async () => {
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

describe("a dead sandbox no longer locks the organization out (#17924)", () => {
  // Sibling describes do not inherit the suite above's beforeEach, and these
  // assertions count calls — without this the counts accumulate across tests.
  beforeEach(() => {
    listByOrganization.mockReset();
    createAgent.mockReset();
    enqueueAgentProvision.mockReset();
    deleteSandbox.mockReset();
    checkAgentCreditGate.mockReset();
    findLatestAgentLifecycleJob.mockReset();
  });

  const DEAD_ROW = {
    id: "agent-dead",
    organization_id: "org-1",
    status: "error",
    bridge_url: null,
  };
  const HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  function orgWithNewestRow(row: Record<string, unknown>) {
    checkAgentCreditGate.mockResolvedValue({ allowed: true, balance: 5 });
    listByOrganization.mockResolvedValue([row]);
  }

  test("an errored row is re-armed in place: same agent id, no second agent minted", async () => {
    orgWithNewestRow(DEAD_ROW);
    findLatestAgentLifecycleJob.mockResolvedValue({ completed_at: HOUR_AGO });
    enqueueAgentProvision.mockResolvedValue({ id: "job-1" });

    const result = await ensureElizaAppProvisioning({
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(enqueueAgentProvision).toHaveBeenCalledWith({
      agentId: "agent-dead",
      organizationId: "org-1",
      userId: "user-1",
      agentName: "Eliza",
    });
    // Minting a second row would leave the org with two agents and orphan the
    // first — the reuse path exists precisely to keep one row per org.
    expect(createAgent).not.toHaveBeenCalled();
    expect(result.agentId).toBe("agent-dead");
  });

  test("the reported status stays error — the row only moves when the daemon claims the job", async () => {
    orgWithNewestRow(DEAD_ROW);
    findLatestAgentLifecycleJob.mockResolvedValue({ completed_at: HOUR_AGO });
    enqueueAgentProvision.mockResolvedValue({ id: "job-1" });

    const result = await ensureElizaAppProvisioning({
      organizationId: "org-1",
      userId: "user-1",
    });

    // Claiming "provisioning" here would be a state the database does not have,
    // and the stuck-provisioning reaper would never sweep it back.
    expect(result.status).toBe("error");
  });

  test("a second message inside the cooldown does not enqueue again", async () => {
    orgWithNewestRow(DEAD_ROW);
    findLatestAgentLifecycleJob.mockResolvedValue({
      completed_at: new Date(Date.now() - 60 * 1000).toISOString(),
    });

    const result = await ensureElizaAppProvisioning({
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(enqueueAgentProvision).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
  });

  test("the cooldown is measured from the JOB, so row writes cannot push it out forever", async () => {
    // updated_at on the sandbox is bumped by heartbeat/reconciler/billing; if the
    // cooldown keyed on it, those writers would re-create the permanent lockout.
    orgWithNewestRow({ ...DEAD_ROW, updated_at: new Date().toISOString() });
    findLatestAgentLifecycleJob.mockResolvedValue({ completed_at: HOUR_AGO });
    enqueueAgentProvision.mockResolvedValue({ id: "job-1" });

    await ensureElizaAppProvisioning({
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(enqueueAgentProvision).toHaveBeenCalledTimes(1);
  });

  test("a row with no prior job is re-armed immediately", async () => {
    orgWithNewestRow(DEAD_ROW);
    findLatestAgentLifecycleJob.mockResolvedValue(null);
    enqueueAgentProvision.mockResolvedValue({ id: "job-1" });

    await ensureElizaAppProvisioning({
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(enqueueAgentProvision).toHaveBeenCalledTimes(1);
  });

  test("a drained organization is still refused before any compute is minted", async () => {
    orgWithNewestRow(DEAD_ROW);
    checkAgentCreditGate.mockResolvedValue({ allowed: false, balance: 0 });
    findLatestAgentLifecycleJob.mockResolvedValue({ completed_at: HOUR_AGO });

    const result = await ensureElizaAppProvisioning({
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(enqueueAgentProvision).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
    expect(result.status).toBe("insufficient_credits");
  });

  test("a lifecycle conflict is absorbed, not surfaced as a 500", async () => {
    orgWithNewestRow(DEAD_ROW);
    findLatestAgentLifecycleJob.mockResolvedValue({ completed_at: HOUR_AGO });
    enqueueAgentProvision.mockRejectedValue(
      new ApiError(409, "session_not_ready", "Agent agent-dead has unresolved replacement cleanup"),
    );

    const result = await ensureElizaAppProvisioning({
      organizationId: "org-1",
      userId: "user-1",
    });

    // runOnboardingChat has no enclosing try/catch: an escaping 409 would 500
    // the user's whole turn over a condition that resolves itself.
    expect(result.status).toBe("error");
  });

  test("a non-conflict enqueue failure still escapes", async () => {
    orgWithNewestRow(DEAD_ROW);
    findLatestAgentLifecycleJob.mockResolvedValue({ completed_at: HOUR_AGO });
    enqueueAgentProvision.mockRejectedValue(new Error("database is on fire"));

    await expect(
      ensureElizaAppProvisioning({ organizationId: "org-1", userId: "user-1" }),
    ).rejects.toThrow("database is on fire");
  });

  test("a row being deleted gets a NEW agent, never a revival", async () => {
    orgWithNewestRow({ ...DEAD_ROW, status: "deletion_pending" });
    createAgent.mockResolvedValue({
      agent: { id: "agent-fresh", status: "pending", bridge_url: null },
      idempotent: false,
    });
    enqueueAgentProvision.mockResolvedValue({ id: "job-2" });

    const result = await ensureElizaAppProvisioning({
      organizationId: "org-1",
      userId: "user-1",
    });

    // Re-arming mid-teardown would race the deletion for the same container.
    expect(createAgent).toHaveBeenCalled();
    expect(result.agentId).toBe("agent-fresh");
  });

  test("a healthy row still short-circuits — no job, no new agent", async () => {
    orgWithNewestRow({
      ...DEAD_ROW,
      status: "running",
      bridge_url: "https://a.test",
    });

    const result = await ensureElizaAppProvisioning({
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(enqueueAgentProvision).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
    expect(result.status).toBe("running");
  });
});
