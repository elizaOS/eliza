/**
 * PR shepherd live-task matching through the real runner host.
 *
 * The shepherd creates at most one live coding task per pull request. A live
 * task without a receipt key still counts when its title or original request
 * names the pull request, but only that exact pull request: `#1` must not be
 * suppressed by a live task for `#12`, whose URL and title start with the
 * same characters.
 *
 * Real AgentRuntime + SQLiteDatabaseAdapter; the GitHub reader and the
 * orchestrator task writer are the injected ports the recipe resolves by
 * service type.
 */

import {
  AgentRuntime,
  createCharacter,
  type IAgentRuntime,
  Service,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildPrShepherdScheduleInput,
  GITHUB_PR_SHEPHERD_SERVICE_TYPE,
  ORCHESTRATOR_TASK_SERVICE_TYPE,
  type PrShepherdPullRequest,
} from "./coding-agent-schedules.js";
import { ScheduledTaskRunnerService } from "./scheduled-task/runner-service.js";

interface StoredTask {
  id: string;
  title: string;
  status: string;
  originalRequest: string;
  metadata?: Record<string, unknown>;
}

let assignedPullRequests: PrShepherdPullRequest[] = [];
let storedTasks: StoredTask[] = [];

class TestGitHubPrShepherdService extends Service {
  static override readonly serviceType = GITHUB_PR_SHEPHERD_SERVICE_TYPE;
  readonly capabilityDescription = "test assigned pull request reader";

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<TestGitHubPrShepherdService> {
    return new TestGitHubPrShepherdService(runtime);
  }

  async listAssignedOpenPullRequests(): Promise<PrShepherdPullRequest[]> {
    return assignedPullRequests;
  }

  async stop(): Promise<void> {}
}

class TestOrchestratorTaskService extends Service {
  static override readonly serviceType = ORCHESTRATOR_TASK_SERVICE_TYPE;
  readonly capabilityDescription = "test coding task writer";

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<TestOrchestratorTaskService> {
    return new TestOrchestratorTaskService(runtime);
  }

  async createTask(input: {
    title: string;
    originalRequest?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string; metadata?: Record<string, unknown> }> {
    const task: StoredTask = {
      id: `coding-task-${storedTasks.length + 1}`,
      title: input.title,
      status: "open",
      originalRequest: input.originalRequest ?? "",
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    storedTasks.push(task);
    return { id: task.id, metadata: task.metadata };
  }

  async listTasks(): Promise<StoredTask[]> {
    return storedTasks.map(({ metadata: _metadata, ...task }) => task);
  }

  async getTask(taskId: string): Promise<StoredTask | null> {
    return storedTasks.find((task) => task.id === taskId) ?? null;
  }

  async stop(): Promise<void> {}
}

function pullRequest(
  number: number,
  signals: Pick<PrShepherdPullRequest, "reviewDecision" | "checksConclusion">,
): PrShepherdPullRequest {
  return {
    owner: "acme",
    repo: "widgets",
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    ...signals,
  };
}

const activeRuntimes: AgentRuntime[] = [];

afterEach(async () => {
  assignedPullRequests = [];
  storedTasks = [];
  while (activeRuntimes.length > 0) {
    await activeRuntimes.pop()?.stop();
  }
});

async function fireShepherd(): Promise<string> {
  const runtime = new AgentRuntime({
    character: createCharacter({ name: "Shepherd" }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  activeRuntimes.push(runtime);
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(":memory:", runtime.agentId),
  );
  await runtime.initialize();
  await runtime.registerService(TestGitHubPrShepherdService);
  await runtime.registerService(TestOrchestratorTaskService);
  await runtime.getServiceLoadPromise(GITHUB_PR_SHEPHERD_SERVICE_TYPE);
  await runtime.getServiceLoadPromise(ORCHESTRATOR_TASK_SERVICE_TYPE);

  const service = await ScheduledTaskRunnerService.start(runtime);
  const runner = service.getRunner({ agentId: runtime.agentId });
  const schedule = await runner.schedule(
    buildPrShepherdScheduleInput({
      agentId: runtime.agentId,
      trigger: { kind: "manual" },
      repo: "acme/widgets",
    }),
  );
  const result = await runner.fireWithResult(schedule.taskId);
  return result.kind;
}

describe("pr-shepherd live task matching", () => {
  it("creates a task for a PR whose number prefixes a PR with a live task", async () => {
    assignedPullRequests = [
      pullRequest(12, { reviewDecision: "CHANGES_REQUESTED" }),
      pullRequest(1, { checksConclusion: "failure" }),
    ];

    expect(await fireShepherd()).toBe("fired");

    expect(storedTasks.map((task) => task.title)).toEqual([
      "PR shepherd: acme/widgets#12",
      "PR shepherd: acme/widgets#1",
    ]);
    expect(storedTasks[1]?.metadata?.prShepherdReceiptKey).toBe(
      "pr-shepherd:acme/widgets#1",
    );
  }, 60_000);

  it("is not suppressed by an unrelated task that names a longer PR number", async () => {
    storedTasks = [
      {
        id: "operator-task",
        title: "Rebase acme/widgets",
        status: "active",
        originalRequest:
          "Rebase https://github.com/acme/widgets/pull/105 onto main.",
      },
    ];
    assignedPullRequests = [
      pullRequest(10, { reviewDecision: "CHANGES_REQUESTED" }),
    ];

    expect(await fireShepherd()).toBe("fired");

    expect(storedTasks.map((task) => task.title)).toEqual([
      "Rebase acme/widgets",
      "PR shepherd: acme/widgets#10",
    ]);
  }, 60_000);

  it("still treats a task that names the exact PR as live", async () => {
    storedTasks = [
      {
        id: "operator-task-1",
        title: "Review follow-up",
        status: "active",
        originalRequest:
          "Answer the review on https://github.com/acme/widgets/pull/1.",
      },
      {
        id: "operator-task-12",
        title: "Fix PR shepherd: acme/widgets#12 checks",
        status: "open",
        originalRequest: "See https://github.com/acme/widgets/pull/12/checks",
      },
    ];
    assignedPullRequests = [
      pullRequest(1, { reviewDecision: "CHANGES_REQUESTED" }),
      pullRequest(12, { checksConclusion: "failure" }),
    ];

    expect(await fireShepherd()).toBe("fired");

    expect(storedTasks.map((task) => task.id)).toEqual([
      "operator-task-1",
      "operator-task-12",
    ]);
  }, 60_000);
});
