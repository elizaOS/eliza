/**
 * Tests for the pr-shepherd coding-agent schedule seam.
 *
 * The harness uses the real ScheduledTask runner and fake public services for
 * GitHub and orchestrator lookup. That keeps the contract focused on the seam:
 * schedules persist and refire through the spine, while coding tasks are
 * created only through runtime service lookup.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildPrShepherdScheduleInput,
  CODING_AGENT_SCHEDULE_METADATA_KEY,
  createCodingAgentScheduleDispatcher,
  deleteCodingAgentSchedule,
  GITHUB_PR_SHEPHERD_SERVICE_TYPE,
  type GitHubPrShepherdService,
  ORCHESTRATOR_TASK_SERVICE_TYPE,
  PR_SHEPHERD_DISPATCH_CHANNEL,
  type PrShepherdPullRequest,
  pauseCodingAgentSchedule,
  resumeCodingAgentSchedule,
} from "./coding-agent-schedules.js";
import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./scheduled-task/completion-check-registry.js";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "./scheduled-task/consolidation-policy.js";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "./scheduled-task/escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./scheduled-task/gate-registry.js";
import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  type ScheduledTaskRunnerHandle,
  type ScheduledTaskStore,
} from "./scheduled-task/runner.js";
import { createInMemoryScheduledTaskLogStore } from "./scheduled-task/state-log.js";

interface CreatedTask {
  id: string;
  title: string;
  goal: string;
  kind?: string;
  originalRequest?: string;
  status: string;
  projectId?: string | null;
  metadata: Record<string, unknown>;
}

function makePr(overrides: Partial<PrShepherdPullRequest> = {}) {
  return {
    owner: "elizaOS",
    repo: "eliza",
    number: 123,
    title: "Fix flaky check",
    url: "https://github.com/elizaOS/eliza/pull/123",
    reviewDecision: "CHANGES_REQUESTED" as const,
    behindBase: false,
    checksConclusion: "success" as const,
    ...overrides,
  };
}

function makeOrchestrator() {
  const tasks: CreatedTask[] = [];
  return {
    tasks,
    service: {
      async createTask(input: Omit<CreatedTask, "id" | "status">) {
        const task: CreatedTask = {
          id: `task-${tasks.length + 1}`,
          status: "open",
          ...input,
        };
        tasks.push(task);
        return { id: task.id, metadata: task.metadata };
      },
      async listTasks() {
        return tasks.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          originalRequest: task.originalRequest,
          projectId: task.projectId ?? null,
        }));
      },
      async getTask(taskId: string) {
        return tasks.find((task) => task.id === taskId) ?? null;
      },
    },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function makeHarness(args: {
  agentId?: string;
  prs?: PrShepherdPullRequest[];
  initialIso?: string;
  settings?: Record<string, string | undefined>;
  useInjectedGithubService?: boolean;
}) {
  const agentId = args.agentId ?? "agent-a";
  let nowIso = args.initialIso ?? "2026-07-17T12:00:00.000Z";
  let prs = args.prs ?? [makePr()];
  const useInjectedGithubService = args.useInjectedGithubService ?? true;
  const github: GitHubPrShepherdService = {
    async listAssignedOpenPullRequests(input) {
      expect(input.agentId).toBe(agentId);
      return prs;
    },
  };
  const orchestrator = makeOrchestrator();
  const runtime = {
    agentId,
    fetch: vi.fn(),
    getSetting(key: string) {
      return args.settings?.[key];
    },
    getService(type: string) {
      if (
        type === GITHUB_PR_SHEPHERD_SERVICE_TYPE &&
        useInjectedGithubService
      ) {
        return github;
      }
      if (type === ORCHESTRATOR_TASK_SERVICE_TYPE) {
        return orchestrator.service;
      }
      return null;
    },
    reportError: () => undefined,
  } as unknown as IAgentRuntime;

  const store = createInMemoryScheduledTaskStore();
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  const runner = createScheduledTaskRunner({
    agentId,
    store,
    logStore: createInMemoryScheduledTaskLogStore(),
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ({ timezone: "UTC" }),
    globalPause: { current: async () => ({ active: false }) },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: createCodingAgentScheduleDispatcher(runtime),
    newTaskId: () => `schedule-${agentId}`,
    now: () => new Date(nowIso),
  });
  return {
    agentId,
    runtime,
    runner,
    store,
    orchestrator,
    setNow(iso: string) {
      nowIso = iso;
    },
    setPrs(next: PrShepherdPullRequest[]) {
      prs = next;
    },
    cloneRunnerWithSameStore() {
      return cloneRunner({
        agentId,
        store,
        runtime,
        now: () => new Date(nowIso),
      });
    },
  };
}

function createGitHubFetchStub() {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    calls.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (url === "https://api.github.com/user") {
      return Response.json({ login: "assigned-user" });
    }
    if (url === "https://api.github.com/graphql") {
      return Response.json({
        data: {
          search: {
            nodes: [
              {
                number: 123,
                title: "Fix flaky check",
                url: "https://github.com/elizaOS/eliza/pull/123",
                headRefName: "fix/flaky",
                baseRefName: "develop",
                reviewDecision: "CHANGES_REQUESTED",
                mergeStateStatus: "CLEAN",
                repository: {
                  name: "eliza",
                  owner: { login: "elizaOS" },
                },
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: { state: "SUCCESS" },
                      },
                    },
                  ],
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }
    throw new Error(`unexpected GitHub request ${url}`);
  });
  return { fetch, calls };
}

function cloneRunner(args: {
  agentId: string;
  store: ScheduledTaskStore;
  runtime: IAgentRuntime;
  now: () => Date;
}): ScheduledTaskRunnerHandle {
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  return createScheduledTaskRunner({
    agentId: args.agentId,
    store: args.store,
    logStore: createInMemoryScheduledTaskLogStore(),
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ({ timezone: "UTC" }),
    globalPause: { current: async () => ({ active: false }) },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: createCodingAgentScheduleDispatcher(args.runtime),
    now: args.now,
  });
}

async function schedulePrShepherd(
  runner: ScheduledTaskRunnerHandle,
  agentId: string,
  everyMinutes = 60,
) {
  return runner.schedule(
    buildPrShepherdScheduleInput({
      agentId,
      trigger: { kind: "interval", everyMinutes },
      projectId: "project-a",
      policy: {
        allowProposeFixes: true,
        maxTasksPerRun: 2,
      },
    }),
  );
}

describe("pr-shepherd coding-agent schedules", () => {
  it("creates a scoped coding task with merge disabled receipts", async () => {
    const h = makeHarness({
      prs: [makePr({ behindBase: true, checksConclusion: "failed" })],
    });
    const schedule = await schedulePrShepherd(h.runner, h.agentId);
    const result = await h.runner.fireWithResult(schedule.taskId);
    expect(result.kind).toBe("fired");
    expect(h.orchestrator.tasks).toHaveLength(1);
    const task = h.orchestrator.tasks[0];
    expect(task.title).toBe("PR shepherd: elizaOS/eliza#123");
    expect(task.kind).toBe("coding");
    expect(task.goal).toContain("Do not merge the pull request.");
    expect(task.metadata.mergeDisabled).toBe(true);
    expect(task.metadata.prShepherdReceipt).toMatchObject({
      receiptKey: "pr-shepherd:elizaOS/eliza#123",
      mergeDisabled: true,
    });
    expect(task.metadata.signals).toEqual([
      "changes_requested",
      "behind_base",
      "failed_checks",
    ]);
  });

  it("suppresses duplicate runs for the same live PR task", async () => {
    const h = makeHarness({ prs: [makePr()] });
    const schedule = await schedulePrShepherd(h.runner, h.agentId);
    await h.runner.fireWithResult(schedule.taskId);
    h.setNow("2026-07-17T13:00:00.000Z");
    await h.runner.fireWithResult(schedule.taskId, {
      allowTerminalRefire: true,
    });
    expect(h.orchestrator.tasks).toHaveLength(1);
  });

  it("suppresses duplicate task creation across concurrent dispatcher fires", async () => {
    const gate = deferred();
    let listCalls = 0;
    const h = makeHarness({ prs: [makePr()] });
    const originalList = h.orchestrator.service.listTasks;
    h.orchestrator.service.listTasks = vi.fn(async () => {
      listCalls += 1;
      if (listCalls === 1) await gate.promise;
      return originalList();
    });
    const schedule = await schedulePrShepherd(h.runner, h.agentId);
    const record = {
      taskId: schedule.taskId,
      firedAtIso: "2026-07-17T12:00:00.000Z",
      channelKey: PR_SHEPHERD_DISPATCH_CHANNEL,
      promptInstructions: schedule.promptInstructions,
      contextRequest: schedule.contextRequest,
      metadata: schedule.metadata,
    };
    const dispatcher = createCodingAgentScheduleDispatcher({
      agentId: h.agentId,
      getService(type: string) {
        if (type === GITHUB_PR_SHEPHERD_SERVICE_TYPE) {
          return {
            async listAssignedOpenPullRequests() {
              return [makePr()];
            },
          };
        }
        if (type === ORCHESTRATOR_TASK_SERVICE_TYPE) {
          return h.orchestrator.service;
        }
        return null;
      },
    } as unknown as IAgentRuntime);
    const first = dispatcher.dispatch(record);
    const second = dispatcher.dispatch(record);
    gate.resolve();
    await Promise.all([first, second]);
    expect(h.orchestrator.tasks).toHaveLength(1);
  });

  it("keeps one live task per PR while allowing distinct PRs", async () => {
    const h = makeHarness({
      prs: [
        makePr({ number: 1, url: "https://github.com/elizaOS/eliza/pull/1" }),
        makePr({ number: 2, url: "https://github.com/elizaOS/eliza/pull/2" }),
      ],
    });
    const schedule = await schedulePrShepherd(h.runner, h.agentId);
    await h.runner.fireWithResult(schedule.taskId);
    expect(h.orchestrator.tasks.map((task) => task.title)).toEqual([
      "PR shepherd: elizaOS/eliza#1",
      "PR shepherd: elizaOS/eliza#2",
    ]);
  });

  it("bounds missed interval catch-up to one task creation pass", async () => {
    const h = makeHarness({
      initialIso: "2026-07-17T12:00:00.000Z",
      prs: [
        makePr({ number: 1, url: "https://github.com/elizaOS/eliza/pull/1" }),
        makePr({ number: 2, url: "https://github.com/elizaOS/eliza/pull/2" }),
        makePr({ number: 3, url: "https://github.com/elizaOS/eliza/pull/3" }),
      ],
    });
    const schedule = await schedulePrShepherd(h.runner, h.agentId);
    await h.runner.fireWithResult(schedule.taskId);
    h.setNow("2026-07-20T12:00:00.000Z");
    await h.runner.fireWithResult(schedule.taskId, {
      allowTerminalRefire: true,
    });
    expect(h.orchestrator.tasks).toHaveLength(3);
  });

  it("resumes persisted schedules after a fresh runner boot", async () => {
    const h = makeHarness({ prs: [makePr()] });
    const schedule = await schedulePrShepherd(h.runner, h.agentId);
    const booted = h.cloneRunnerWithSameStore();
    await booted.fireWithResult(schedule.taskId);
    expect(h.orchestrator.tasks).toHaveLength(1);
  });

  it("pauses, resumes, and deletes a coding-agent schedule", async () => {
    const h = makeHarness({ prs: [makePr()] });
    const schedule = await schedulePrShepherd(h.runner, h.agentId);
    const paused = await pauseCodingAgentSchedule(h.runner, schedule.taskId);
    const metadata = paused.metadata?.[CODING_AGENT_SCHEDULE_METADATA_KEY];
    expect(metadata).toMatchObject({ paused: true });
    await h.runner.fireWithResult(schedule.taskId);
    expect(h.orchestrator.tasks).toHaveLength(0);
    const resumed = await resumeCodingAgentSchedule(h.runner, schedule.taskId);
    const dispatcher = createCodingAgentScheduleDispatcher(h.runtime);
    await dispatcher.dispatch({
      taskId: resumed.taskId,
      firedAtIso: "2026-07-17T13:01:00.000Z",
      channelKey: PR_SHEPHERD_DISPATCH_CHANNEL,
      promptInstructions: resumed.promptInstructions,
      contextRequest: resumed.contextRequest,
      metadata: resumed.metadata,
    });
    expect(h.orchestrator.tasks).toHaveLength(1);
    await deleteCodingAgentSchedule(h.store, schedule.taskId);
    expect(await h.store.get(schedule.taskId)).toBeNull();
  });

  it("isolates schedule ownership to the runtime agent", async () => {
    const h = makeHarness({ agentId: "agent-a", prs: [makePr()] });
    const schedule = await h.runner.schedule(
      buildPrShepherdScheduleInput({
        agentId: "agent-b",
        trigger: { kind: "interval", everyMinutes: 60 },
      }),
    );
    const result = await h.runner.fireWithResult(schedule.taskId);
    expect(result.kind).toBe("dispatch_failed");
    expect(h.orchestrator.tasks).toHaveLength(0);
  });

  it("does not create tasks for healthy PRs", async () => {
    const h = makeHarness({
      prs: [
        makePr({
          reviewDecision: "APPROVED",
          behindBase: false,
          checksConclusion: "success",
        }),
      ],
    });
    const schedule = await schedulePrShepherd(h.runner, h.agentId);
    await h.runner.fireWithResult(schedule.taskId);
    expect(h.orchestrator.tasks).toHaveLength(0);
  });

  it("caps maxTasksPerRun at the scheduling ceiling", async () => {
    const prs = Array.from({ length: 25 }, (_, index) =>
      makePr({
        number: index + 1,
        url: `https://github.com/elizaOS/eliza/pull/${index + 1}`,
      }),
    );
    const h = makeHarness({ prs });
    const schedule = await h.runner.schedule(
      buildPrShepherdScheduleInput({
        agentId: h.agentId,
        trigger: { kind: "interval", everyMinutes: 60 },
        projectId: "project-a",
        policy: {
          allowProposeFixes: true,
          maxTasksPerRun: 1000,
        },
      }),
    );
    await h.runner.fireWithResult(schedule.taskId);
    expect(h.orchestrator.tasks).toHaveLength(20);
  });

  it("rejects invalid PR fields before creating tasks", async () => {
    const h = makeHarness({
      prs: [{ ...makePr(), url: "https://example.com/not-github" }],
    });
    const schedule = await schedulePrShepherd(h.runner, h.agentId);
    const result = await h.runner.fireWithResult(schedule.taskId);
    expect(result.kind).toBe("dispatch_failed");
    expect(h.orchestrator.tasks).toHaveLength(0);
  });

  it("uses GITHUB_TOKEN before GH_PAT for the default GitHub reader", async () => {
    const github = createGitHubFetchStub();
    const h = makeHarness({
      useInjectedGithubService: false,
      settings: {
        GITHUB_TOKEN: " github-token ",
        GH_PAT: "gh-pat",
      },
    });
    h.runtime.fetch = github.fetch;

    const schedule = await schedulePrShepherd(h.runner, h.agentId);
    const result = await h.runner.fireWithResult(schedule.taskId);

    expect(result.kind).toBe("fired");
    expect(h.orchestrator.tasks).toHaveLength(1);
    expect(github.calls).toHaveLength(2);
    expect(github.calls.map((call) => call.authorization)).toEqual([
      "Bearer github-token",
      "Bearer github-token",
    ]);
  });

  it("falls back to GH_PAT for the default GitHub reader", async () => {
    const github = createGitHubFetchStub();
    const h = makeHarness({
      useInjectedGithubService: false,
      settings: {
        GH_PAT: "gh-pat",
      },
    });
    h.runtime.fetch = github.fetch;

    const schedule = await schedulePrShepherd(h.runner, h.agentId);
    const result = await h.runner.fireWithResult(schedule.taskId);

    expect(result.kind).toBe("fired");
    expect(h.orchestrator.tasks).toHaveLength(1);
    expect(github.calls.map((call) => call.authorization)).toEqual([
      "Bearer gh-pat",
      "Bearer gh-pat",
    ]);
  });

  it("fails without a GitHub token when no PR shepherd service is injected", async () => {
    const h = makeHarness({
      useInjectedGithubService: false,
      settings: {},
    });
    const fetch = vi.fn();
    h.runtime.fetch = fetch;

    const schedule = await schedulePrShepherd(h.runner, h.agentId);
    const result = await h.runner.fireWithResult(schedule.taskId);

    expect(result.kind).toBe("dispatch_failed");
    expect(fetch).not.toHaveBeenCalled();
    expect(h.orchestrator.tasks).toHaveLength(0);
  });

  it("delegates instead of minting work after host-capability substitution", async () => {
    const h = makeHarness({ prs: [makePr()] });
    const schedule = await schedulePrShepherd(h.runner, h.agentId);
    const delegate = { dispatch: vi.fn(async () => ({ ok: true as const })) };
    const dispatcher = createCodingAgentScheduleDispatcher(h.runtime, {
      delegate,
    });

    await dispatcher.dispatch({
      taskId: schedule.taskId,
      firedAtIso: "2026-07-17T12:00:00.000Z",
      // Host-capability substitution uses the generic notification channel,
      // so recipe dispatch must delegate rather than minting coding work.
      channelKey: "in_app",
      promptInstructions: schedule.promptInstructions,
      contextRequest: schedule.contextRequest,
      metadata: schedule.metadata,
    });

    expect(delegate.dispatch).toHaveBeenCalledOnce();
    expect(h.orchestrator.tasks).toHaveLength(0);
  });
});
