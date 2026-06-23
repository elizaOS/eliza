import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Action,
  type IAgentRuntime,
  ModelType,
  type Plugin,
} from "@elizaos/core";
import { AcpService } from "../../../src/services/acp-service.js";
import { augmentTaskWithDeployGuidance } from "../../../src/services/app-deploy-guidance.js";
import { OrchestratorTaskService } from "../../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../../src/services/orchestrator-task-store.js";
import type { OrchestratorTaskDocument } from "../../../src/services/orchestrator-task-types.js";
import {
  runSupervisorTick,
  type SupervisorTaskView,
} from "../../../src/services/task-supervisor-service.js";
import type { SpawnOptions, SpawnResult } from "../../../src/services/types.js";
import type { WorkspaceChangeSet } from "../../../src/services/workspace-diff.js";

export const ORCHESTRATOR_SCENARIO_PLUGIN_NAME =
  "orchestrator-scenario-harness";

export const ORCHESTRATOR_GRILLING_HAPPY_PATH =
  "ORCHESTRATOR_GRILLING_HAPPY_PATH";
export const ORCHESTRATOR_EVIDENCE_BUNDLE = "ORCHESTRATOR_EVIDENCE_BUNDLE";
export const ORCHESTRATOR_MULTI_TASK_SUPERVISOR =
  "ORCHESTRATOR_MULTI_TASK_SUPERVISOR";
export const ORCHESTRATOR_VIEW_CLOUD_DEPLOY = "ORCHESTRATOR_VIEW_CLOUD_DEPLOY";

type ScenarioRuntime = IAgentRuntime & {
  registerPlugin?: (plugin: Plugin) => Promise<void>;
  scenarioLlmFixtures?: {
    register: (...fixtures: Array<Record<string, unknown>>) => void;
  };
  plugins?: Array<{ name?: string }>;
};

type RuntimeWithServices = ScenarioRuntime & {
  getService: <T = unknown>(name: string) => T | null;
};

type LlmProxyCall = {
  params: {
    prompt?: string;
  };
};

type VerifierResponse = {
  passed: boolean;
  summary: string;
  missing: string[];
};

type ScenarioResult = {
  summary: string;
  taskIds: string[];
  sessionIds: string[];
  events: string[];
  finalStatuses: Record<string, string>;
  verifierPrompts?: string[];
  correctivePrompt?: string;
  digest?: string;
  forwardedTo?: string[];
  guidance?: string;
  cloudMock?: {
    calls: Array<{
      command: string;
      body: Record<string, unknown>;
      headers?: Record<string, string>;
    }>;
    manifest: Record<string, unknown>;
  };
};

type TaskDetail = {
  id: string;
  sessions: Array<{ sessionId: string }>;
};

class ScenarioAcpService {
  private handler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | null = null;
  private counter = 0;
  private readonly workdir = mkdtempSync(
    join(tmpdir(), "eliza-orchestrator-scenario-"),
  );
  private readonly sessions = new Map<
    string,
    SpawnResult & { metadata: Record<string, unknown> }
  >();
  readonly sent: Array<{ sessionId: string; text: string }> = [];

  onSessionEvent(
    cb: (sessionId: string, event: string, data: unknown) => void,
  ): () => void {
    this.handler = cb;
    return () => {
      if (this.handler === cb) this.handler = null;
    };
  }

  emit(sessionId: string, event: string, data: unknown = {}): void {
    this.handler?.(sessionId, event, data);
  }

  async spawnSession(opts: SpawnOptions): Promise<SpawnResult> {
    this.counter += 1;
    const sessionId = `orchestrator-scenario-session-${this.counter}`;
    const metadata = { ...(opts.metadata ?? {}) };
    const session: SpawnResult & { metadata: Record<string, unknown> } = {
      sessionId,
      id: sessionId,
      name:
        opts.name ?? metadata.label?.toString() ?? `session-${this.counter}`,
      agentType: opts.agentType ?? "opencode",
      workdir: opts.workdir ?? this.workdir,
      status: "ready",
      metadata,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  async getSession(
    sessionId: string,
  ): Promise<
    (SpawnResult & { metadata: Record<string, unknown> }) | undefined
  > {
    return this.sessions.get(sessionId);
  }

  getChangedPaths(_sessionId: string): string[] {
    return [];
  }

  async updateSessionMetadata(
    sessionId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.metadata = { ...session.metadata, ...patch };
  }

  async sendToSession(
    sessionId: string,
    text: string,
  ): Promise<{
    sessionId: string;
    finalText: string;
    response: string;
    stopReason: string;
    durationMs: number;
  }> {
    this.sent.push({ sessionId, text });
    return {
      sessionId,
      finalText: "scenario follow-up accepted",
      response: "scenario follow-up accepted",
      stopReason: "end_turn",
      durationMs: 1,
    };
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) session.status = "stopped";
  }
}

class OrchestratorScenarioHarness {
  readonly acp = new ScenarioAcpService();
  readonly store = new OrchestratorTaskStore({ backend: "memory" });
  readonly taskService: OrchestratorTaskService;
  readonly verifierPrompts: string[] = [];

  constructor(runtime: ScenarioRuntime) {
    this.taskService = new OrchestratorTaskService(runtime, {
      store: this.store,
    });
  }

  async start(): Promise<void> {
    await this.taskService.start();
  }

  captureVerifierPrompt(call: LlmProxyCall): void {
    this.verifierPrompts.push(call.params.prompt ?? "");
  }

  async runGrillingHappyPath(): Promise<ScenarioResult> {
    const task = (await this.taskService.createTask({
      title: "Proof-backed cache fix",
      goal: "Fix the cache invalidation bug and prove the tests pass.",
      originalRequest: "Please fix cache invalidation and show proof.",
      kind: "coding",
      roomId: "scenario-room-grill",
      worldId: "scenario-world",
      metadata: { source: "scenario-runner" },
      acceptanceCriteria: [
        "cache invalidation bug is fixed",
        "tests pass with pasted output",
      ],
    })) as TaskDetail;
    const detail = (await this.taskService.spawnAgentForTask(task.id, {
      label: "Ada",
      task: "Fix cache invalidation and report only when proven.",
    })) as TaskDetail | null;
    const sessionId = detail?.sessions[0]?.sessionId;
    if (!sessionId) throw new Error("expected a spawned scenario session");

    this.acp.emit(sessionId, "task_complete", {
      response: "I finished the cache fix; tests should be good.",
    });
    const firstDoc = await this.waitForDoc(
      task.id,
      (doc) =>
        doc.task.status === "active" &&
        doc.events.some((event) => event.eventType === "auto_verify_failed") &&
        this.acp.sent.length > 0,
      "first automatic verification failure",
    );
    const correctivePrompt = this.acp.sent.at(-1)?.text ?? "";

    await this.taskService.addMessage(task.id, {
      content:
        "Ran bun test cache: Tests 4 passed (4). Cache invalidation now clears stale entries.",
      senderKind: "sub_agent",
      sessionId,
      direction: "stdout",
    });
    await this.acp.updateSessionMetadata(sessionId, {
      lastChangeSet: cacheChangeSet(),
    });
    this.acp.emit(sessionId, "task_complete", {
      response:
        "Cache invalidation is fixed. Proof: Tests 4 passed (4), with cache invalidation assertions green.",
    });
    const finalDoc = await this.waitForDoc(
      task.id,
      (doc) =>
        doc.task.status === "done" &&
        doc.events.some((event) => event.eventType === "validation_passed"),
      "second automatic verification pass",
    );

    return {
      summary:
        "proofless sub-agent completion failed verification, the corrective evidence checklist was sent, then the re-report with pasted Tests 4 passed (4) output passed validation",
      taskIds: [task.id],
      sessionIds: [sessionId],
      correctivePrompt,
      verifierPrompts: [...this.verifierPrompts],
      events: eventTypes(finalDoc),
      finalStatuses: { [task.id]: finalDoc.task.status },
      digest: `first=${firstDoc.task.status}; final=${finalDoc.task.status}`,
    };
  }

  async runEvidenceBundle(): Promise<ScenarioResult> {
    const task = (await this.taskService.createTask({
      title: "Evidence bundle verifier check",
      goal: "Add a cache implementation and prove it with diff, tests, and URL evidence.",
      originalRequest: "Implement cache proof bundle.",
      kind: "coding",
      roomId: "scenario-room-evidence",
      worldId: "scenario-world",
      metadata: { source: "scenario-runner" },
      acceptanceCriteria: [
        "cache diff is present",
        "tests pass with output",
        "public URL is verified",
      ],
    })) as TaskDetail;
    const detail = (await this.taskService.spawnAgentForTask(task.id, {
      label: "Lin",
      task: "Create cache evidence and report with proof.",
    })) as TaskDetail | null;
    const sessionId = detail?.sessions[0]?.sessionId;
    if (!sessionId) throw new Error("expected a spawned scenario session");

    await this.acp.updateSessionMetadata(sessionId, {
      lastChangeSet: cacheChangeSet(),
    });
    await this.taskService.addMessage(task.id, {
      content:
        "Ran bun test cache: Tests 8 passed (8). Verified https://app.example.com/cache returned HTTP 200.",
      senderKind: "sub_agent",
      sessionId,
      direction: "stdout",
    });
    this.acp.emit(sessionId, "task_complete", {
      response: "Added caching and verified it works.",
    });
    const finalDoc = await this.waitForDoc(
      task.id,
      (doc) =>
        doc.task.status === "done" &&
        doc.events.some((event) => event.eventType === "validation_passed"),
      "evidence bundle verification pass",
    );
    const prompt = this.verifierPrompts.at(-1) ?? "";
    const missingEvidence = [
      "## CHANGESET",
      "src/cache.ts",
      "Tests 8 passed (8)",
      "https://app.example.com/cache",
    ].filter((needle) => !prompt.includes(needle));
    if (missingEvidence.length > 0) {
      throw new Error(
        `verifier prompt missed evidence: ${missingEvidence.join(", ")}`,
      );
    }

    return {
      summary:
        "diff, test stdout, and verified URL reached the automatic verifier prompt before validation passed: ## CHANGESET src/cache.ts (1 file changed, 20 insertions(+)); ## TEST / BUILD / TYPECHECK OUTPUT Tests 8 passed (8); ## VERIFIED URLS https://app.example.com/cache",
      taskIds: [task.id],
      sessionIds: [sessionId],
      verifierPrompts: [...this.verifierPrompts],
      events: eventTypes(finalDoc),
      finalStatuses: { [task.id]: finalDoc.task.status },
      digest:
        "prompt included ## CHANGESET src/cache.ts, 1 file changed, 20 insertions(+), ## TEST / BUILD / TYPECHECK OUTPUT, Tests 8 passed (8), ## VERIFIED URLS, and https://app.example.com/cache",
    };
  }

  async runMultiTaskSupervisor(): Promise<ScenarioResult> {
    const roomId = "scenario-room-multitask";
    const [alpha, beta] = await Promise.all([
      this.taskService.createTask({
        title: "Alpha transcript parser",
        goal: "Fix the alpha transcript parser.",
        originalRequest: "Run alpha task.",
        kind: "coding",
        roomId,
        worldId: "scenario-world",
        metadata: { source: "scenario-runner" },
        acceptanceCriteria: ["alpha parser tests pass"],
      }) as Promise<TaskDetail>,
      this.taskService.createTask({
        title: "Beta browser callback",
        goal: "Fix beta browser callback wait.",
        originalRequest: "Run beta task.",
        kind: "coding",
        roomId,
        worldId: "scenario-world",
        metadata: { source: "scenario-runner" },
        acceptanceCriteria: ["beta callback tests pass"],
      }) as Promise<TaskDetail>,
    ]);
    const alphaDetail = (await this.taskService.spawnAgentForTask(alpha.id, {
      label: "Ada",
    })) as TaskDetail | null;
    const betaDetail = (await this.taskService.spawnAgentForTask(beta.id, {
      label: "Lin",
    })) as TaskDetail | null;
    const alphaSession = alphaDetail?.sessions[0]?.sessionId;
    const betaSession = betaDetail?.sessions[0]?.sessionId;
    if (!alphaSession || !betaSession) {
      throw new Error("expected two spawned scenario sessions");
    }

    const post = await this.taskService.postUserMessage(
      alpha.id,
      "Only alpha should receive this failing test output: alpha.spec.ts passed.",
    );
    if (
      post?.forwardedTo.length !== 1 ||
      post.forwardedTo[0] !== alphaSession
    ) {
      throw new Error(
        `expected alpha-only forwarding, saw ${JSON.stringify(post)}`,
      );
    }
    const betaReceivedAlphaMessage = this.acp.sent.some(
      (entry) =>
        entry.sessionId === betaSession && entry.text.includes("Only alpha"),
    );
    if (betaReceivedAlphaMessage) {
      throw new Error("beta session received alpha-only user turn");
    }

    const tasks = await this.taskService.listTasks({ includeArchived: false });
    const views: SupervisorTaskView[] = await Promise.all(
      tasks.map(async (task) => ({
        id: task.id,
        label: task.title,
        status: task.status,
        activeSessions: task.activeSessionCount,
        sessionLabel: task.latestSessionLabel,
        origin: await this.taskService.getTaskOriginTarget(task.id),
      })),
    );
    const digests: string[] = [];
    await runSupervisorTick(
      views,
      async (_target, content) => {
        digests.push(String(content.text ?? ""));
      },
      new Map(),
    );
    const digest = digests.join("\n---\n");
    for (const needle of [
      "Task update",
      "Alpha transcript parser",
      "Beta browser callback",
      "active",
    ]) {
      if (!digest.includes(needle)) {
        throw new Error(`supervisor digest missed ${needle}: ${digest}`);
      }
    }

    return {
      summary: `two concurrent orchestrator tasks stayed isolated, user message forwarded only to ${post.forwardedTo.join(", ")}, and supervisor emitted one room digest covering both active tasks: ${digest}`,
      taskIds: [alpha.id, beta.id],
      sessionIds: [alphaSession, betaSession],
      forwardedTo: post.forwardedTo,
      events: [],
      finalStatuses: Object.fromEntries(
        tasks.map((task) => [task.id, task.status]),
      ),
      digest,
    };
  }

  async runViewCloudDeploy(): Promise<ScenarioResult> {
    const sourceDir = "/workspace/plugins/plugin-weather-panel";
    const task = [
      "Build a view plugin for Weather Panel.",
      `The plugin source directory is ${sourceDir}. It has already been scaffolded.`,
      "Target cloud deployment with viewKind release and affiliate code aff_8918.",
    ].join("\n");
    const guidance = augmentTaskWithDeployGuidance(task, { target: "cloud" });
    const requiredGuidance = [
      "View Plugin Deployment (Eliza Cloud)",
      "Build the view bundle",
      "apps.create",
      "viewKind",
      "Cloud CDN `bundleUrl`",
      "X-Affiliate-Code",
      "Cloud app sandboxes are isolated and ephemeral",
      sourceDir,
    ];
    const missingGuidance = requiredGuidance.filter(
      (needle) => !guidance.includes(needle),
    );
    if (missingGuidance.length > 0) {
      throw new Error(
        `view cloud guidance missed: ${missingGuidance.join(", ")}`,
      );
    }

    const manifest = {
      name: "@scenario/plugin-weather-panel",
      viewKind: "release",
      views: [
        {
          id: "weather-panel",
          path: "/apps/weather-panel",
          viewType: "gui",
          componentExport: "WeatherPanelView",
          viewKind: "release",
          bundleUrl:
            "https://cdn.eliza.cloud/apps/weather-panel/weather-panel.js",
        },
      ],
    };
    const cloudMock = {
      calls: [
        {
          command: "apps.create",
          headers: { "X-Affiliate-Code": "aff_8918" },
          body: {
            slug: "weather-panel",
            sourceDir,
            manifest,
          },
        },
      ],
      manifest,
    };

    return {
      summary:
        "cloud:mock registered the view plugin with apps.create, release viewKind, Cloud CDN bundleUrl, and affiliate header",
      taskIds: [],
      sessionIds: [],
      events: [],
      finalStatuses: {},
      guidance,
      cloudMock,
      digest:
        "apps.create slug=weather-panel viewKind=release bundleUrl=https://cdn.eliza.cloud/apps/weather-panel/weather-panel.js X-Affiliate-Code=aff_8918",
    };
  }

  private async waitForDoc(
    taskId: string,
    predicate: (doc: OrchestratorTaskDocument) => boolean,
    label: string,
  ): Promise<OrchestratorTaskDocument> {
    const deadline = Date.now() + 4_000;
    let last: OrchestratorTaskDocument | null = null;
    while (Date.now() < deadline) {
      last = await this.store.getTask(taskId);
      if (last && predicate(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `timed out waiting for ${label}; last status=${last?.task.status ?? "(missing)"}, events=${last ? eventTypes(last).join(",") : "(none)"}`,
    );
  }
}

const baseGetServiceByRuntime = new WeakMap<
  ScenarioRuntime,
  RuntimeWithServices["getService"]
>();
const baseGetServiceLoadPromiseByRuntime = new WeakMap<
  ScenarioRuntime,
  (name: string) => Promise<unknown>
>();
const harnessByRuntime = new WeakMap<
  ScenarioRuntime,
  OrchestratorScenarioHarness
>();

export async function installOrchestratorScenarioHarness(ctx: {
  runtime?: unknown;
}): Promise<OrchestratorScenarioHarness> {
  const runtime = ctx.runtime as ScenarioRuntime | undefined;
  if (!runtime) throw new Error("scenario runtime is not available");
  const previous = process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
  process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "1";
  if (previous === "0") {
    process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "1";
  }

  if (!baseGetServiceByRuntime.has(runtime)) {
    baseGetServiceByRuntime.set(
      runtime,
      ((runtime as RuntimeWithServices).getService ?? (() => null)).bind(
        runtime,
      ),
    );
  }
  if (!baseGetServiceLoadPromiseByRuntime.has(runtime)) {
    const runtimeWithLoadPromise = runtime as unknown as {
      getServiceLoadPromise?: (name: string) => Promise<unknown>;
    };
    const loadPromise = runtimeWithLoadPromise.getServiceLoadPromise;
    if (typeof loadPromise === "function") {
      baseGetServiceLoadPromiseByRuntime.set(
        runtime,
        loadPromise.bind(runtime),
      );
    }
  }

  (runtime as RuntimeWithServices).getService = function getScenarioService<T>(
    name: string,
  ): T | null {
    const harness = harnessByRuntime.get(runtime);
    if (harness && name === AcpService.serviceType) {
      return harness.acp as T;
    }
    if (harness && name === OrchestratorTaskService.serviceType) {
      return harness.taskService as T;
    }
    const base = baseGetServiceByRuntime.get(runtime);
    return base ? base<T>(name) : null;
  };
  const runtimeWithLoadPromise = runtime as unknown as {
    getServiceLoadPromise?: (name: string) => Promise<unknown>;
  };
  runtimeWithLoadPromise.getServiceLoadPromise = async (
    name: string,
  ): Promise<unknown> => {
    const harness = harnessByRuntime.get(runtime);
    if (harness && name === AcpService.serviceType) return harness.acp;
    if (harness && name === OrchestratorTaskService.serviceType) {
      return harness.taskService;
    }
    const base = baseGetServiceLoadPromiseByRuntime.get(runtime);
    if (base) return base(name);
    throw new Error(`Service ${name} not found or failed to start`);
  };

  const harness = new OrchestratorScenarioHarness(runtime);
  harnessByRuntime.set(runtime, harness);
  await registerHarnessPlugin(runtime);
  await harness.start();
  return harness;
}

export function registerVerifierFixtures(
  runtime: ScenarioRuntime,
  actionName: string,
  responses: VerifierResponse[],
): void {
  let index = 0;
  runtime.scenarioLlmFixtures?.register({
    name: `${actionName.toLowerCase()}-goal-verifier`,
    match: {
      modelType: ModelType.TEXT_SMALL,
      prompt: /You are a demanding engineering manager/,
    },
    response: (call: LlmProxyCall) => {
      const harness = harnessByRuntime.get(runtime);
      harness?.captureVerifierPrompt(call);
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return JSON.stringify(response);
    },
    times: responses.length,
  });
}

export function registerJudgeFixture(
  runtime: ScenarioRuntime,
  actionName: string,
): void {
  runtime.scenarioLlmFixtures?.register({
    name: `${actionName.toLowerCase()}-final-judge`,
    match: {
      modelType: ModelType.TEXT_LARGE,
      prompt: (value: string) =>
        value.includes("Score the candidate response against the rubric") &&
        value.includes(actionName),
    },
    response: JSON.stringify({
      score: 1,
      reason: "scenario trace proves the requested orchestrator flow",
    }),
    times: 1,
  });
}

function cacheChangeSet(): WorkspaceChangeSet {
  return {
    changedFiles: ["src/cache.ts"],
    diffStat: "1 file changed, 20 insertions(+)",
    diff: "diff --git a/src/cache.ts b/src/cache.ts\n+export const cache = new Map();",
    truncated: false,
    capturedAt: Date.now(),
  };
}

async function registerHarnessPlugin(runtime: ScenarioRuntime): Promise<void> {
  const registered = runtime.plugins?.some(
    (plugin) => plugin.name === ORCHESTRATOR_SCENARIO_PLUGIN_NAME,
  );
  if (registered) return;
  await runtime.registerPlugin?.({
    name: ORCHESTRATOR_SCENARIO_PLUGIN_NAME,
    description:
      "Deterministic scenario actions for orchestrator evidence tests",
    actions: [
      scenarioAction(
        ORCHESTRATOR_GRILLING_HAPPY_PATH,
        "Drive a proofless completion through the automatic verifier grill, then prove the re-report.",
        (harness) => harness.runGrillingHappyPath(),
      ),
      scenarioAction(
        ORCHESTRATOR_EVIDENCE_BUNDLE,
        "Assert diff, test stdout, and URL evidence reach the verifier.",
        (harness) => harness.runEvidenceBundle(),
      ),
      scenarioAction(
        ORCHESTRATOR_MULTI_TASK_SUPERVISOR,
        "Assert two orchestrator tasks stay isolated and produce a supervisor digest.",
        (harness) => harness.runMultiTaskSupervisor(),
      ),
      scenarioAction(
        ORCHESTRATOR_VIEW_CLOUD_DEPLOY,
        "Assert cloud-targeted view-plugin guidance yields apps.create, viewKind, Cloud CDN bundleUrl, and affiliate evidence.",
        (harness) => harness.runViewCloudDeploy(),
      ),
    ],
  });
}

function scenarioAction(
  name: string,
  description: string,
  run: (harness: OrchestratorScenarioHarness) => Promise<ScenarioResult>,
): Action {
  return {
    name,
    description,
    validate: async () => true,
    handler: async (runtime) => {
      const harness = harnessByRuntime.get(runtime as ScenarioRuntime);
      if (!harness) {
        return {
          success: false,
          text: "orchestrator scenario harness was not installed",
          error: "missing harness",
        };
      }
      const result = await run(harness);
      return {
        success: true,
        text: result.summary,
        userFacingText: result.summary,
        verifiedUserFacing: true,
        data: result,
      };
    },
  };
}

function eventTypes(doc: OrchestratorTaskDocument): string[] {
  return doc.events.map((event) => event.eventType);
}
