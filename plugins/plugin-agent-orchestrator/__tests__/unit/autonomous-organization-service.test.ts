/** Exercises durable autonomous organization planning, worker reconciliation, retries, and restart recovery. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  delegatedOrganizationAuthorizer,
  InMemoryOrganizationStore,
  type OrganizationStore,
  toOrganizationCommandId,
  toOrganizationId,
  toOrganizationPrincipalId,
  toOrganizationTimestamp,
} from "@elizaos/core/contracts/agent-organization";
import { createMockRuntime } from "@elizaos/core/testing";
import { describe, expect, it, vi } from "vitest";
import {
  AutonomousOrganizationService,
  authoritativeOrganizationResult,
  buildOrganizationWorkerPrompt,
  type OrganizationPlanner,
  type OrganizationWorkerCandidate,
  type OrganizationWorkerExecutionStatus,
  type OrganizationWorkerHost,
  parseOrganizationPlan,
} from "../../src/services/autonomous-organization-service.js";
import { FileOrganizationStore } from "../../src/services/organization-file-store.js";

const candidates: readonly OrganizationWorkerCandidate[] = [
  {
    id: "analyst",
    name: "Tess",
    role: "analyst",
    capabilities: ["analysis"],
    framework: "codex",
  },
  {
    id: "reviewer",
    name: "Milo",
    role: "reviewer",
    capabilities: ["review"],
    framework: "claude",
  },
];

const planner: OrganizationPlanner = {
  plan: vi.fn(async () => ({
    name: "Autonomous delivery team",
    selectedMembers: [
      { candidateId: "analyst", role: "lead analyst" },
      { candidateId: "reviewer", role: "independent reviewer" },
    ],
    workItems: [
      {
        id: "analyze",
        objective: "Analyze the objective",
        assigneeCandidateId: "analyst",
        dependsOnWorkItemIds: [],
      },
      {
        id: "review",
        objective: "Review the analysis",
        assigneeCandidateId: "reviewer",
        dependsOnWorkItemIds: ["analyze"],
      },
    ],
  })),
  recover: vi.fn(async () => ({
    candidateId: "reviewer",
    reason: "Use the independent reviewer after the analysis worker failed",
  })),
};

class IdempotentWorkerHost implements OrganizationWorkerHost {
  readonly ensureCalls: string[] = [];
  readonly executions = new Map<string, OrganizationWorkerExecutionStatus>();

  async ensureWorker(input: {
    organizationId: string;
    workItemId: string;
    member: OrganizationWorkerCandidate;
  }): Promise<{ executionId: string }> {
    const executionId = `${input.organizationId}:${input.workItemId}:${input.member.id}`;
    this.ensureCalls.push(`${input.workItemId}:${input.member.id}`);
    if (!this.executions.has(executionId)) {
      this.executions.set(executionId, { kind: "running" });
    }
    return { executionId };
  }

  async status(
    executionId: string,
  ): Promise<OrganizationWorkerExecutionStatus> {
    return (
      this.executions.get(executionId) ?? {
        kind: "failed",
        error: "missing execution",
      }
    );
  }
}

function service(
  store: InMemoryOrganizationStore,
  workerHost: OrganizationWorkerHost,
): AutonomousOrganizationService {
  return new AutonomousOrganizationService(
    createMockRuntime({ getService: () => null }),
    {
      store,
      planner,
      workerHost,
      candidates: async () => candidates,
      now: () => new Date("2026-08-27T12:00:00.000Z"),
    },
  );
}

describe("AutonomousOrganizationService", () => {
  it("uses the elected ACP coordinator session output without trimming it", () => {
    const result = authoritativeOrganizationResult({
      completionCoordinatorSessionId: "acp-coordinator",
      sessions: [
        {
          sessionId: "contributor",
          completionSummary: "wrong contributor result",
        },
        {
          sessionId: "acp-coordinator",
          completionSummary: "  complete coordinator result  ",
        },
      ],
    });

    expect(result).toBe("  complete coordinator result  ");
  });

  it("passes complete prerequisite results to dependent workers without compaction", () => {
    const first = "A".repeat(20_000);
    const second = "tail evidence";
    const prompt = buildOrganizationWorkerPrompt({
      objective: "Review the prior work",
      dependencyResults: [first, second],
    });

    expect(prompt).toContain(first);
    expect(prompt).toContain(second);
    expect(prompt.endsWith(JSON.stringify([first, second]))).toBe(true);
  });

  it("creates a durable team from one objective and starts only dependency-ready work", async () => {
    const store = new InMemoryOrganizationStore(
      delegatedOrganizationAuthorizer,
    );
    const host = new IdempotentWorkerHost();
    const organization = await service(store, host).startOrganization({
      requestId: "request-1",
      sponsorPrincipalId: "human-1",
      objective: "Investigate and review an ambiguous requirement",
    });

    expect(
      organization.organization.members.map((member) => member.id),
    ).toEqual(["coordinator", "analyst", "reviewer"]);
    expect(host.ensureCalls).toEqual(["analyze:analyst"]);
    expect(organization.organization.workItems).toMatchObject([
      { id: "analyze", status: "in_progress" },
      { id: "review", status: "assigned" },
    ]);
  });

  it("resumes from persisted state, adopts completed work, and starts its dependent", async () => {
    const store = new InMemoryOrganizationStore(
      delegatedOrganizationAuthorizer,
    );
    const host = new IdempotentWorkerHost();
    const firstService = service(store, host);
    let organization = await firstService.startOrganization({
      requestId: "request-resume",
      sponsorPrincipalId: "human-1",
      objective: "Analyze then review",
    });
    const analysis = organization.organization.workItems.find(
      (item) => item.id === "analyze",
    );
    if (!analysis?.executionId) throw new Error("analysis execution missing");
    host.executions.set(analysis.executionId, {
      kind: "completed",
      result: "Analysis complete",
    });

    const restartedService = service(store, host);
    organization = await restartedService.reconcile(
      organization.organization.id,
    );

    expect(organization.organization.workItems).toMatchObject([
      { id: "analyze", status: "completed", result: "Analysis complete" },
      { id: "review", status: "in_progress" },
    ]);
    expect(host.ensureCalls).toEqual(["analyze:analyst", "review:reviewer"]);
  });

  it("repairs a crash after organization creation but before planning", async () => {
    const store = new InMemoryOrganizationStore(
      delegatedOrganizationAuthorizer,
    );
    await store.apply({
      organizationId: toOrganizationId("crash-before-plan"),
      commandId: toOrganizationCommandId("create-before-crash"),
      expectedRevision: 0,
      actorPrincipalId: toOrganizationPrincipalId("human-1"),
      issuedAt: toOrganizationTimestamp("2026-08-27T11:59:00.000Z"),
      command: {
        type: "create_organization",
        name: "Interrupted organization",
        goal: "Analyze then review",
      },
    });

    const host = new IdempotentWorkerHost();
    const [resumed] = await service(store, host).resumeAll();

    expect(resumed?.organization.members).toHaveLength(3);
    expect(resumed?.organization.workItems).toHaveLength(2);
    expect(host.ensureCalls).toEqual(["analyze:analyst"]);
  });

  it("repairs a crash after execution binding but before in-progress status", async () => {
    const base = new InMemoryOrganizationStore(delegatedOrganizationAuthorizer);
    let interrupt = true;
    const interruptedStore: OrganizationStore = {
      get: (organizationId) => base.get(organizationId),
      list: () => base.list(),
      apply: async (envelope) => {
        if (
          interrupt &&
          envelope.command.type === "update_work_status" &&
          envelope.command.status === "in_progress"
        ) {
          throw new Error("simulated process stop after binding");
        }
        return base.apply(envelope);
      },
    };
    const host = new IdempotentWorkerHost();
    const interruptedService = new AutonomousOrganizationService(
      createMockRuntime({ getService: () => null }),
      {
        store: interruptedStore,
        planner,
        workerHost: host,
        candidates: async () => candidates,
        now: () => new Date("2026-08-27T12:00:00.000Z"),
      },
    );
    await expect(
      interruptedService.startOrganization({
        requestId: "crash-after-bind",
        sponsorPrincipalId: "human-1",
        objective: "Analyze then review",
      }),
    ).rejects.toThrow("simulated process stop after binding");
    interrupt = false;

    const [repaired] = await new AutonomousOrganizationService(
      createMockRuntime({ getService: () => null }),
      {
        store: interruptedStore,
        planner,
        workerHost: host,
        candidates: async () => candidates,
        now: () => new Date("2026-08-27T12:01:00.000Z"),
      },
    ).resumeAll();

    expect(repaired?.organization.workItems[0]).toMatchObject({
      id: "analyze",
      status: "in_progress",
    });
  });

  it("reloads file-backed revisions into a new service instance", async () => {
    const root = await mkdtemp(join(tmpdir(), "eliza-organization-restart-"));
    try {
      const host = new IdempotentWorkerHost();
      const firstStore = new FileOrganizationStore(root, {
        authorize: delegatedOrganizationAuthorizer,
      });
      const first = new AutonomousOrganizationService(
        createMockRuntime({ getService: () => null }),
        {
          store: firstStore,
          planner,
          workerHost: host,
          candidates: async () => candidates,
          now: () => new Date("2026-08-27T12:00:00.000Z"),
        },
      );
      const organization = await first.startOrganization({
        requestId: "file-backed-restart",
        sponsorPrincipalId: "human-1",
        objective: "Analyze then review",
      });
      const analysis = organization.organization.workItems[0];
      if (!analysis?.executionId) throw new Error("analysis execution missing");
      host.executions.set(analysis.executionId, {
        kind: "completed",
        result: "persisted analysis",
      });

      const restarted = new AutonomousOrganizationService(
        createMockRuntime({ getService: () => null }),
        {
          store: new FileOrganizationStore(root, {
            authorize: delegatedOrganizationAuthorizer,
          }),
          planner,
          workerHost: host,
          candidates: async () => candidates,
          now: () => new Date("2026-08-27T12:01:00.000Z"),
        },
      );
      const [resumed] = await restarted.resumeAll();

      expect(resumed?.organization.workItems).toMatchObject([
        { id: "analyze", status: "completed", result: "persisted analysis" },
        { id: "review", status: "in_progress" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("converges duplicate kickoff delivery without duplicate durable work", async () => {
    const store = new InMemoryOrganizationStore(
      delegatedOrganizationAuthorizer,
    );
    const host = new IdempotentWorkerHost();
    let timestamp = 0;
    const organizationService = new AutonomousOrganizationService(
      createMockRuntime({ getService: () => null }),
      {
        store,
        planner,
        workerHost: host,
        candidates: async () => candidates,
        now: () => new Date(1_787_827_200_000 + timestamp++),
      },
    );
    const input = {
      requestId: "duplicate-request",
      sponsorPrincipalId: "human-1",
      objective: "Analyze then review",
    };

    const [first, second] = await Promise.all([
      organizationService.startOrganization(input),
      organizationService.startOrganization(input),
    ]);

    expect(first.organization.id).toBe(second.organization.id);
    expect(first.organization.workItems).toHaveLength(2);
    expect(second.organization.workItems).toHaveLength(2);
    expect(new Set(host.ensureCalls)).toEqual(new Set(["analyze:analyst"]));
  });

  it("rejects reuse of a kickoff id by another sponsor or objective", async () => {
    const store = new InMemoryOrganizationStore(
      delegatedOrganizationAuthorizer,
    );
    const host = new IdempotentWorkerHost();
    const organizationService = service(store, host);
    await organizationService.startOrganization({
      requestId: "collision-request",
      sponsorPrincipalId: "human-1",
      objective: "Original objective",
    });

    await expect(
      organizationService.startOrganization({
        requestId: "collision-request",
        sponsorPrincipalId: "human-2",
        objective: "Replacement objective",
      }),
    ).rejects.toMatchObject({ code: "ORGANIZATION_REQUEST_ID_COLLISION" });
  });

  it("never adopts another sponsor's concurrent kickoff collision", async () => {
    const store = new InMemoryOrganizationStore(
      delegatedOrganizationAuthorizer,
    );
    const host = new IdempotentWorkerHost();
    const organizationService = service(store, host);
    const outcomes = await Promise.allSettled([
      organizationService.startOrganization({
        requestId: "concurrent-authority-collision",
        sponsorPrincipalId: "human-1",
        objective: "First objective",
      }),
      organizationService.startOrganization({
        requestId: "concurrent-authority-collision",
        sponsorPrincipalId: "human-2",
        objective: "Second objective",
      }),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { code: "ORGANIZATION_REQUEST_ID_COLLISION" },
    });
  });

  it("autonomously reassigns failed work and clears its stale execution", async () => {
    const store = new InMemoryOrganizationStore(
      delegatedOrganizationAuthorizer,
    );
    const host = new IdempotentWorkerHost();
    const organizationService = service(store, host);
    let organization = await organizationService.startOrganization({
      requestId: "recovery-request",
      sponsorPrincipalId: "human-1",
      objective: "Analyze then review",
    });
    const analysis = organization.organization.workItems.find(
      (item) => item.id === "analyze",
    );
    if (!analysis?.executionId) throw new Error("analysis execution missing");
    host.executions.set(analysis.executionId, {
      kind: "failed",
      error: "analysis worker crashed",
    });

    organization = await organizationService.reconcile(
      organization.organization.id,
    );

    expect(
      organization.organization.workItems.find((item) => item.id === "analyze"),
    ).toMatchObject({
      assigneeMemberId: "reviewer",
      status: "assigned",
    });
    expect(
      organization.organization.workItems.find((item) => item.id === "analyze"),
    ).not.toHaveProperty("executionId");

    organization = await organizationService.reconcile(
      organization.organization.id,
    );
    expect(
      organization.organization.workItems.find((item) => item.id === "analyze"),
    ).toMatchObject({
      assigneeMemberId: "reviewer",
      status: "in_progress",
    });
    expect(host.ensureCalls).toEqual(["analyze:analyst", "analyze:reviewer"]);
  });

  it("resumeAll completes persisted organizations after workers finish", async () => {
    const store = new InMemoryOrganizationStore(
      delegatedOrganizationAuthorizer,
    );
    const host = new IdempotentWorkerHost();
    const firstService = service(store, host);
    let organization = await firstService.startOrganization({
      requestId: "complete-after-restart",
      sponsorPrincipalId: "human-1",
      objective: "Analyze then review",
    });
    const analysis = organization.organization.workItems[0];
    if (!analysis?.executionId) throw new Error("analysis execution missing");
    host.executions.set(analysis.executionId, {
      kind: "completed",
      result: "analysis result",
    });
    organization = await firstService.reconcile(organization.organization.id);
    const review = organization.organization.workItems.find(
      (item) => item.id === "review",
    );
    if (!review?.executionId) throw new Error("review execution missing");
    host.executions.set(review.executionId, {
      kind: "completed",
      result: "review result",
    });

    const [resumed] = await service(store, host).resumeAll();

    expect(resumed?.organization.status).toBe("completed");
    expect(
      resumed?.organization.workItems.every(
        (item) => item.status === "completed",
      ),
    ).toBe(true);
  });

  it("rejects a planner assignment to an unavailable candidate before spawning", async () => {
    const store = new InMemoryOrganizationStore(
      delegatedOrganizationAuthorizer,
    );
    const host = new IdempotentWorkerHost();
    const invalidPlanner: OrganizationPlanner = {
      plan: async () => ({
        name: "Invalid",
        selectedMembers: [{ candidateId: "ghost", role: "ghost" }],
        workItems: [
          {
            id: "ghost-work",
            objective: "Do hidden work",
            assigneeCandidateId: "ghost",
            dependsOnWorkItemIds: [],
          },
        ],
      }),
      recover: async () => ({ candidateId: "ghost", reason: "invalid" }),
    };
    const organizationService = new AutonomousOrganizationService(
      createMockRuntime({ getService: () => null }),
      {
        store,
        planner: {
          plan: async (input) => {
            const plan = await invalidPlanner.plan(input);
            return parseOrganizationPlan(plan, input.candidates);
          },
          recover: invalidPlanner.recover,
        },
        workerHost: host,
        candidates: async () => candidates,
      },
    );

    await expect(
      organizationService.startOrganization({
        requestId: "invalid-plan",
        sponsorPrincipalId: "human-1",
        objective: "Do work",
      }),
    ).rejects.toMatchObject({
      code: "ORGANIZATION_PLAN_CANDIDATE_UNAVAILABLE",
    });
    expect(host.ensureCalls).toEqual([]);
  });
});
