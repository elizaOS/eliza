import {
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import { DIRECT_ROUTE_CASES, escapeRegExp } from "./apps-session-route-cases";
import {
  assertReadyChecks,
  expectNoPageDiagnostics,
  hideContinuousChatOverlay,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

type RouteCase = (typeof DIRECT_ROUTE_CASES)[number];

type JsonRecord = Record<string, unknown>;

const SMOKE_AT = "2026-01-01T00:00:00.000Z";
const ONE_PX_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function routeReadyChecks(routeCase: RouteCase): readonly ReadyCheck[] {
  return "readyChecks" in routeCase
    ? routeCase.readyChecks
    : [{ selector: routeCase.selector }];
}

function routeTimeout(routeCase: RouteCase): number {
  return "timeoutMs" in routeCase ? routeCase.timeoutMs : 60_000;
}

function routeCaseByName(name: string): RouteCase {
  const routeCase = DIRECT_ROUTE_CASES.find((item) => item.name === name);
  expect(
    routeCase,
    `${name} must be registered as a direct app route case`,
  ).toBeTruthy();
  return routeCase as RouteCase;
}

async function openRouteCase(page: Page, routeCase: RouteCase): Promise<void> {
  await openAppPath(page, routeCase.path);
  await assertReadyChecks(
    page,
    routeCase.name,
    routeReadyChecks(routeCase),
    "any",
    routeTimeout(routeCase),
  );
}

async function clickRequired(locator: Locator, label: string): Promise<void> {
  const target = locator.first();
  await expect(target, `${label} should be visible`).toBeVisible();
  await expect(target, `${label} should be enabled`).toBeEnabled();
  await target.click();
}

async function expectAnyTextareaValue(
  page: Page,
  pattern: RegExp,
): Promise<void> {
  await expect
    .poll(
      async () =>
        page.locator("textarea").evaluateAll((nodes, source) => {
          const regex = new RegExp(source);
          return nodes.some((node) =>
            regex.test((node as HTMLTextAreaElement).value),
          );
        }, pattern.source),
      {
        message: `expected a textarea value to match ${pattern}`,
      },
    )
    .toBe(true);
}

async function openVisiblePageSidebar(
  page: Page,
  testId: string,
): Promise<Locator> {
  const trigger = page.getByTestId("page-layout-mobile-sidebar-trigger");
  if (await trigger.isVisible().catch(() => false)) {
    await trigger.click();
  }

  const sidebar = page.locator(`[data-testid="${testId}"]:visible`).first();
  await expect(sidebar, `${testId} should be visible`).toBeVisible();
  return sidebar;
}

async function closeMobilePageSidebar(page: Page): Promise<void> {
  const drawer = page.getByTestId("page-layout-mobile-sidebar-drawer");
  if (!(await drawer.isVisible().catch(() => false))) return;
  await clickRequired(
    drawer.getByRole("button", { name: "Close sidebar" }),
    "close mobile page sidebar",
  );
  await expect(drawer).toBeHidden();
}

function uiLabelPattern(label: string, translationKey: string): RegExp {
  return new RegExp(
    `${escapeRegExp(label)}|${escapeRegExp(translationKey)}`,
    "i",
  );
}

async function fulfillJson(
  route: Route,
  body: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function readRequestJson<T extends JsonRecord>(route: Route): T {
  const raw = route.request().postData() ?? "{}";
  return JSON.parse(raw) as T;
}

async function installModelTesterInteractionRoutes(page: Page) {
  const statusRequests: string[] = [];
  const runRequests: Array<JsonRecord & { test?: string; prompt?: string }> =
    [];

  await page.route("**/api/model-tester/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    statusRequests.push(route.request().url());
    await fulfillJson(route, {
      tests: [
        {
          id: "text-small",
          label: "Text",
          modelType: "TEXT_SMALL",
          available: true,
          providers: ["deterministic-ui-smoke"],
        },
        {
          id: "text-large",
          label: "Streaming Text",
          modelType: "TEXT_LARGE",
          available: true,
          providers: ["deterministic-ui-smoke"],
        },
        {
          id: "embedding",
          label: "Embedding",
          modelType: "TEXT_EMBEDDING",
          available: true,
          providers: ["deterministic-ui-smoke"],
        },
        {
          id: "text-to-speech",
          label: "Voice",
          modelType: "TEXT_TO_SPEECH",
          available: true,
          providers: ["deterministic-ui-smoke"],
        },
        {
          id: "transcription",
          label: "Transcription",
          modelType: "TRANSCRIPTION",
          available: true,
          providers: ["deterministic-ui-smoke"],
        },
        {
          id: "vad",
          label: "Voice Activity",
          modelType: "TEXT_SMALL",
          available: true,
          providers: ["deterministic-ui-smoke"],
        },
        {
          id: "image-description",
          label: "Image Description",
          modelType: "IMAGE_DESCRIPTION",
          available: true,
          providers: ["deterministic-ui-smoke"],
        },
        {
          id: "image",
          label: "Image Generation",
          modelType: "IMAGE",
          available: true,
          providers: ["deterministic-ui-smoke"],
        },
      ],
    });
  });

  await page.route("**/api/model-tester/run", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = readRequestJson<
      JsonRecord & { test?: string; prompt?: string }
    >(route);
    runRequests.push(body);
    const prompt = body.prompt ?? "";
    const outputByTest: Record<string, unknown> = {
      "text-small": `Text probe accepted: ${prompt}`,
      "text-large": "Streaming probe accepted from deterministic UI smoke.",
      embedding: { dimensions: 3, values: [0.125, 0.25, 0.5] },
      "text-to-speech": { contentType: "audio/wav", base64: "UklGRgAAAAA=" },
      transcription: "synthetic transcript from UI smoke",
      vad: { segments: [{ start: 0, end: 1.25, active: true }] },
      "image-description": "synthetic image description from UI smoke",
      image: {
        images: [
          {
            url: ONE_PX_PNG_DATA_URL,
          },
        ],
        note: "image generation accepted",
      },
    };
    const testId = body.test ?? "text-small";
    await fulfillJson(route, {
      ok: true,
      test: testId,
      durationMs: 7,
      output: outputByTest[testId] ?? `ran ${testId}`,
    });
  });

  return {
    statusRequestCount: () => statusRequests.length,
    runRequestCount: () => runRequests.length,
    runRequests: () => runRequests.slice(),
  };
}

function trainingDataset(
  id: string,
  sampleCount: number,
  trajectoryCount: number,
) {
  return {
    id,
    createdAt: SMOKE_AT,
    jsonlPath: `/tmp/eliza-ui-smoke-training/${id}.jsonl`,
    trajectoryDir: `/tmp/eliza-ui-smoke-training/${id}`,
    metadataPath: `/tmp/eliza-ui-smoke-training/${id}.metadata.json`,
    sampleCount,
    trajectoryCount,
  };
}

function trainingJob(
  id: string,
  status: "queued" | "running" | "completed" | "failed" | "cancelled",
  datasetId: string,
  progress: number,
  logs: string[],
) {
  return {
    id,
    createdAt: SMOKE_AT,
    startedAt: SMOKE_AT,
    completedAt: status === "completed" ? "2026-01-01T00:02:00.000Z" : null,
    status,
    phase: status === "completed" ? "complete" : "train",
    progress,
    error: null,
    exitCode: status === "completed" ? 0 : null,
    signal: null,
    options: { datasetId, backend: "cpu", iterations: 3 },
    datasetId,
    pythonRoot: "/tmp/eliza-ui-smoke-training/python",
    scriptPath: "/tmp/eliza-ui-smoke-training/train.py",
    outputDir: `/tmp/eliza-ui-smoke-training/jobs/${id}`,
    logPath: `/tmp/eliza-ui-smoke-training/jobs/${id}/train.log`,
    modelPath:
      status === "completed"
        ? `/tmp/eliza-ui-smoke-training/jobs/${id}/model.gguf`
        : null,
    adapterPath:
      status === "completed"
        ? `/tmp/eliza-ui-smoke-training/jobs/${id}/adapter`
        : null,
    modelId: status === "completed" ? "smoke-model-a" : null,
    logs,
  };
}

function trainingModel(id: string) {
  return {
    id,
    createdAt: SMOKE_AT,
    jobId: "smoke-job-complete",
    outputDir: `/tmp/eliza-ui-smoke-training/models/${id}`,
    modelPath: `/tmp/eliza-ui-smoke-training/models/${id}/model.gguf`,
    adapterPath: `/tmp/eliza-ui-smoke-training/models/${id}/adapter`,
    sourceModel: "base-smoke-model",
    backend: "cpu",
    ollamaModel: null,
    active: false,
    benchmark: {
      status: "not_run",
      lastRunAt: null,
      output: null,
    },
  };
}

function trainingTrajectorySummary(
  id: string,
  agentId: string,
  reward: number,
) {
  return {
    id,
    trajectoryId: id,
    agentId,
    archetype: "ui-smoke",
    createdAt: SMOKE_AT,
    totalReward: reward,
    aiJudgeReward: reward,
    episodeLength: 4,
    hasLlmCalls: true,
    llmCallCount: 2,
  };
}

async function installTrainingInteractionRoutes(page: Page) {
  const datasets = [trainingDataset("smoke-dataset-a", 12, 2)];
  const jobs = [
    trainingJob("smoke-job-complete", "completed", "smoke-dataset-a", 1, [
      "completed deterministic training job",
    ]),
  ];
  const models = [trainingModel("smoke-model-a")];
  const trajectories = [
    trainingTrajectorySummary("smoke-train-001", "agent-smoke-a", 0.91),
    trainingTrajectorySummary("smoke-train-002", "agent-smoke-b", 0.84),
  ];
  const buildDatasetRequests: JsonRecord[] = [];
  const startJobRequests: JsonRecord[] = [];
  const cancelJobRequests: string[] = [];
  const trajectoryDetailRequests: string[] = [];

  function statusBody() {
    return {
      runningJobs: jobs.filter((job) => job.status === "running").length,
      queuedJobs: jobs.filter((job) => job.status === "queued").length,
      completedJobs: jobs.filter((job) => job.status === "completed").length,
      failedJobs: jobs.filter((job) => job.status === "failed").length,
      modelCount: models.length,
      datasetCount: datasets.length,
      runtimeAvailable: true,
    };
  }

  await page.route("**/api/training/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, statusBody());
  });

  await page.route("**/api/training/trajectories**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.pathname === "/api/training/trajectories"
    ) {
      await fulfillJson(route, {
        available: true,
        reason: null,
        total: trajectories.length,
        trajectories,
      });
      return;
    }
    if (
      request.method() === "GET" &&
      url.pathname.startsWith("/api/training/trajectories/")
    ) {
      const trajectoryId = decodeURIComponent(
        url.pathname.split("/").pop() ?? "",
      );
      trajectoryDetailRequests.push(trajectoryId);
      const summary =
        trajectories.find(
          (trajectory) => trajectory.trajectoryId === trajectoryId,
        ) ?? trajectories[0];
      await fulfillJson(route, {
        trajectory: {
          ...summary,
          stepsJson: JSON.stringify(
            {
              trajectoryId,
              summary:
                trajectoryId === "smoke-train-002"
                  ? "Second deterministic training trajectory"
                  : "First deterministic training trajectory",
              calls: ["should_respond", "response"],
            },
            null,
            2,
          ),
          aiJudgeReasoning: "deterministic UI smoke reward",
        },
      });
      return;
    }
    if (
      request.method() === "POST" &&
      url.pathname === "/api/training/trajectories/publish"
    ) {
      await fulfillJson(route, {
        trajectoriesPublished: trajectories.length,
        cloudUpload: { huggingFaceRepo: "ui-smoke/training" },
      });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/training/datasets**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.pathname === "/api/training/datasets"
    ) {
      await fulfillJson(route, { datasets });
      return;
    }
    if (
      request.method() === "POST" &&
      url.pathname === "/api/training/datasets/build"
    ) {
      const body = readRequestJson(route);
      buildDatasetRequests.push(body);
      const dataset = trainingDataset("smoke-dataset-built", 7, 2);
      if (!datasets.some((item) => item.id === dataset.id)) {
        datasets.unshift(dataset);
      }
      await fulfillJson(route, { dataset });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/training/jobs**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/training/jobs") {
      await fulfillJson(route, { jobs });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/training/jobs") {
      const body = readRequestJson(route);
      startJobRequests.push(body);
      const job = trainingJob(
        "smoke-job-created",
        "running",
        String(body.datasetId ?? "smoke-dataset-built"),
        0.42,
        ["started via Playwright", "dataset accepted by deterministic route"],
      );
      const existingIndex = jobs.findIndex((item) => item.id === job.id);
      if (existingIndex >= 0) jobs.splice(existingIndex, 1, job);
      else jobs.unshift(job);
      await fulfillJson(route, { job });
      return;
    }
    if (
      request.method() === "POST" &&
      url.pathname.endsWith("/cancel") &&
      url.pathname.startsWith("/api/training/jobs/")
    ) {
      const jobId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
      cancelJobRequests.push(jobId);
      const job = jobs.find((item) => item.id === jobId);
      if (job) {
        job.status = "cancelled";
        job.phase = "cancelled";
        job.logs = [...job.logs, "cancelled by deterministic UI smoke"];
      }
      await fulfillJson(route, { job });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/training/models**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/training/models") {
      await fulfillJson(route, { models });
      return;
    }
    if (
      request.method() === "POST" &&
      url.pathname.endsWith("/benchmark") &&
      url.pathname.startsWith("/api/training/models/")
    ) {
      const modelId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
      const model = models.find((item) => item.id === modelId);
      if (model) {
        model.benchmark = {
          status: "passed",
          lastRunAt: SMOKE_AT,
          output: "deterministic benchmark passed",
        };
      }
      await fulfillJson(route, { status: "passed", modelId });
      return;
    }
    await route.fallback();
  });

  return {
    buildDatasetRequests: () => buildDatasetRequests.slice(),
    startJobRequests: () => startJobRequests.slice(),
    cancelJobRequests: () => cancelJobRequests.slice(),
    trajectoryDetailRequests: () => trajectoryDetailRequests.slice(),
  };
}

function trajectoryRecord(
  id: string,
  source: string,
  scenarioId: string,
  createdAt: string,
  llmCallCount: number,
) {
  return {
    id,
    source,
    status: "completed",
    startTime: Date.parse(createdAt),
    endTime: Date.parse(createdAt) + 1200,
    durationMs: 1200,
    llmCallCount,
    providerAccessCount: 1,
    totalPromptTokens: 120,
    totalCompletionTokens: 80,
    scenarioId,
    batchId: "batch-ui-smoke",
    createdAt,
    stepCount: 4,
    totalReward: 0.9,
    roomId: null,
    entityId: null,
    conversationId: null,
    metadata: {
      orchestrator: {
        decisionType: "respond",
        taskLabel: `${scenarioId} task`,
        sessionId: `${id}-session`,
      },
    },
    updatedAt: createdAt,
  };
}

function trajectoryLlmCall(
  id: string,
  trajectoryId: string,
  stepType: string,
  model: string,
  response: string,
  tags: string[],
) {
  return {
    id,
    trajectoryId,
    stepId: `${id}-step`,
    timestamp: Date.parse(SMOKE_AT),
    model,
    systemPrompt: "System prompt from deterministic trajectory fixture.",
    userPrompt: `User prompt for ${trajectoryId}`,
    response,
    temperature: 0.1,
    maxTokens: 256,
    purpose: stepType,
    actionType: stepType === "response" ? "reply" : "",
    stepType,
    latencyMs: 19,
    promptTokens: 60,
    completionTokens: 40,
    createdAt: SMOKE_AT,
    tags,
  };
}

async function installTrajectoryViewerInteractionRoutes(page: Page) {
  const records = [
    trajectoryRecord(
      "traj-alpha",
      "chat",
      "scenario-alpha",
      "2026-01-01T00:10:00.000Z",
      2,
    ),
    trajectoryRecord(
      "traj-beta",
      "orchestrator",
      "scenario-beta",
      "2026-01-01T00:20:00.000Z",
      2,
    ),
  ];
  const listRequests: Array<{
    search: string | null;
    offset: number;
    limit: number;
  }> = [];
  const detailRequests: string[] = [];

  function detailFor(id: string) {
    const record = records.find((item) => item.id === id) ?? records[0];
    const alpha = record.id === "traj-alpha";
    return {
      trajectory: record,
      llmCalls: [
        trajectoryLlmCall(
          `${record.id}-should`,
          record.id,
          "should_respond",
          alpha ? "deterministic-model-a" : "deterministic-model-b",
          alpha
            ? '{"decision":"RESPOND","reasoning":"alpha should respond"}'
            : '{"decision":"RESPOND","reasoning":"beta should respond"}',
          ["should_respond"],
        ),
        trajectoryLlmCall(
          `${record.id}-plan`,
          record.id,
          "response",
          alpha ? "deterministic-model-a" : "deterministic-model-b",
          alpha
            ? "Alpha response from Playwright trajectory fixture."
            : "Beta response from Playwright trajectory fixture.",
          ["plan"],
        ),
      ],
      providerAccesses: [
        {
          id: `${record.id}-provider`,
          trajectoryId: record.id,
          stepId: `${record.id}-provider-step`,
          providerName: alpha
            ? "alpha-memory-provider"
            : "beta-memory-provider",
          purpose: "context",
          query: { roomId: `${record.id}-room` },
          data: { memory: `${record.id} deterministic memory` },
          timestamp: Date.parse(SMOKE_AT),
          createdAt: SMOKE_AT,
        },
      ],
      events: [
        {
          id: `${record.id}-tool-call`,
          trajectoryId: record.id,
          stepId: `${record.id}-tool-step`,
          type: "tool_call",
          actionName: "lookup_memory",
          args: { query: record.id },
          status: "completed",
          success: true,
          durationMs: 4,
          timestamp: Date.parse(SMOKE_AT),
          createdAt: SMOKE_AT,
        },
        {
          id: `${record.id}-evaluation`,
          trajectoryId: record.id,
          stepId: `${record.id}-eval-step`,
          type: "evaluation",
          evaluatorName: "deterministic-evaluator",
          status: "completed",
          success: true,
          decision: "pass",
          thought: `${record.id} evaluated deterministically`,
          timestamp: Date.parse(SMOKE_AT) + 1,
          createdAt: SMOKE_AT,
        },
        {
          id: `${record.id}-cache`,
          trajectoryId: record.id,
          type: "cache_observation",
          cacheName: "prompt-cache",
          key: record.id,
          hit: alpha,
          timestamp: Date.parse(SMOKE_AT) + 2,
          createdAt: SMOKE_AT,
        },
        {
          id: `${record.id}-context-diff`,
          trajectoryId: record.id,
          type: "context_diff",
          label: "message context",
          added: 1,
          removed: 0,
          changed: 1,
          tokenDelta: 12,
          timestamp: Date.parse(SMOKE_AT) + 3,
          createdAt: SMOKE_AT,
        },
      ],
      toolEvents: [],
      evaluationEvents: [],
      cacheObservations: [],
      cacheStats: {
        hits: alpha ? 1 : 0,
        misses: alpha ? 0 : 1,
        total: 1,
        hitRate: alpha ? 1 : 0,
      },
      contextDiffs: [],
      contextEvents: [],
    };
  }

  await page.route("**/api/trajectories**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.pathname === "/api/trajectories/stats"
    ) {
      await fulfillJson(route, {
        totalTrajectories: records.length,
        totalLlmCalls: 4,
        totalProviderAccesses: 2,
        totalPromptTokens: 240,
        totalCompletionTokens: 160,
        averageDurationMs: 1200,
        bySource: { chat: 1, orchestrator: 1 },
        byModel: { "deterministic-model-a": 2, "deterministic-model-b": 2 },
      });
      return;
    }
    if (
      request.method() === "GET" &&
      url.pathname === "/api/trajectories/config"
    ) {
      await fulfillJson(route, { enabled: true });
      return;
    }
    if (
      request.method() === "GET" &&
      url.pathname === "/api/trajectories/latest"
    ) {
      await fulfillJson(route, { trajectory: records[0] });
      return;
    }
    if (
      request.method() === "POST" &&
      url.pathname === "/api/trajectories/export"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ exported: true }),
      });
      return;
    }
    if (request.method() === "DELETE" && url.pathname === "/api/trajectories") {
      const body = readRequestJson(route);
      await fulfillJson(route, {
        deleted: Array.isArray(body.trajectoryIds)
          ? body.trajectoryIds.length
          : records.length,
      });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/trajectories") {
      const search = url.searchParams.get("search");
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      listRequests.push({ search, offset, limit });
      const normalizedSearch = search?.trim().toLowerCase();
      const filtered = normalizedSearch
        ? records.filter((record) =>
            [record.id, record.source, record.scenarioId, record.batchId]
              .filter(Boolean)
              .some((value) =>
                String(value).toLowerCase().includes(normalizedSearch),
              ),
          )
        : records;
      await fulfillJson(route, {
        trajectories: filtered.slice(offset, offset + limit),
        total: filtered.length,
        offset,
        limit,
      });
      return;
    }
    if (
      request.method() === "GET" &&
      url.pathname.startsWith("/api/trajectories/")
    ) {
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      detailRequests.push(id);
      await fulfillJson(route, detailFor(id));
      return;
    }
    await route.fallback();
  });

  return {
    listRequestCount: () => listRequests.length,
    listRequests: () => listRequests.slice(),
    detailRequests: () => detailRequests.slice(),
  };
}

test.beforeEach(async ({ page }) => {
  installPageDiagnosticsGuard(page);
  await hideContinuousChatOverlay(page);
  await seedAppStorage(page, {
    "eliza:ui-theme": "dark",
    "elizaos:ui-theme": "dark",
    "eliza:page-sidebar:trajectories:width": "260",
    "elizaos:ui:sidebar:eliza:page-sidebar:trajectories:collapsed": "false",
  });
  await installDefaultAppRoutes(page);
});

test("model tester route runs deterministic visible probes", async ({
  page,
}) => {
  const recorder = await installModelTesterInteractionRoutes(page);
  await openRouteCase(page, routeCaseByName("model tester app window"));

  await expect(page.getByTestId("model-tester-shell")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Model Tester" }),
  ).toBeVisible();
  const smokePrompt =
    "Say exactly one short sentence about the Eliza-1 model tester working.";
  await expect(page.getByRole("button", { name: "Smoke" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const statusRequestCount = recorder.statusRequestCount();
  await clickRequired(
    page.getByRole("button", { name: "Refresh model status" }),
    "model tester refresh",
  );
  await expect
    .poll(() => recorder.statusRequestCount())
    .toBeGreaterThan(statusRequestCount);

  const textCard = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Text" }) })
    .first();
  await expect(textCard.getByText("TEXT_SMALL", { exact: true })).toBeVisible();
  await clickRequired(
    textCard.getByRole("button", { name: "Run" }),
    "run text probe",
  );
  await expect(
    textCard.getByText(`Text probe accepted: ${smokePrompt}`),
  ).toBeVisible();
  await expect
    .poll(() => recorder.runRequests().at(-1)?.test)
    .toBe("text-small");
  await expect
    .poll(() => recorder.runRequests().at(-1)?.prompt)
    .toBe(smokePrompt);

  const imageCard = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Image Generation" }) })
    .first();
  await expect.poll(() => recorder.runRequestCount()).toBeGreaterThanOrEqual(1);
  await clickRequired(
    imageCard.getByRole("button", { name: "Run" }),
    "run image generation probe",
  );
  await expect(imageCard.getByText("image generation accepted")).toBeVisible();
  await expect.poll(() => recorder.runRequests().at(-1)?.test).toBe("image");

  await expectNoPageDiagnostics(page, "model tester interactions");
});

test("fine-tuning route selects trajectories, builds a dataset, and starts a job", async ({
  page,
}) => {
  const recorder = await installTrainingInteractionRoutes(page);
  await openRouteCase(page, routeCaseByName("fine tuning app window"));

  await expect(page.getByTestId("fine-tuning-view")).toBeVisible();
  await expect(page.getByText("smoke-train-001")).toBeVisible();
  await clickRequired(
    page.getByText("smoke-train-002"),
    "training trajectory row",
  );
  await expect
    .poll(() => recorder.trajectoryDetailRequests().includes("smoke-train-002"))
    .toBe(true);
  await expect(page.getByText("agent-smoke-b")).toBeVisible();
  await expectAnyTextareaValue(
    page,
    /Second deterministic training trajectory/,
  );

  await page
    .getByRole("textbox", {
      name: uiLabelPattern(
        "Limit trajectories",
        "finetuningview.LimitTrajectories",
      ),
    })
    .fill("2");
  await page
    .getByRole("textbox", {
      name: uiLabelPattern(
        "Min LLM calls per trajectory",
        "finetuningview.MinLLMCallsPerTr",
      ),
    })
    .fill("1");
  await clickRequired(
    page.getByRole("button", {
      name: uiLabelPattern("Build Dataset", "finetuningview.BuildDataset"),
    }),
    "build dataset",
  );
  await expect
    .poll(() => recorder.buildDatasetRequests().length)
    .toBeGreaterThan(0);
  await expect(recorder.buildDatasetRequests().at(-1)).toMatchObject({
    limit: 2,
    minLlmCallsPerTrajectory: 1,
  });
  await expect(
    page.getByText("smoke-dataset-built", { exact: true }).first(),
  ).toBeVisible();

  await page
    .getByRole("textbox", {
      exact: true,
      name: "Base model",
    })
    .fill("base-model-from-ui-smoke");
  await page
    .getByRole("textbox", {
      exact: true,
      name: "Iterations",
    })
    .fill("3");
  await clickRequired(
    page.getByRole("button", {
      name: uiLabelPattern(
        "Start Training Job",
        "finetuningview.StartTrainingJob",
      ),
    }),
    "start training job",
  );
  await expect
    .poll(() => recorder.startJobRequests().length)
    .toBeGreaterThan(0);
  await expect(recorder.startJobRequests().at(-1)).toMatchObject({
    datasetId: "smoke-dataset-built",
    backend: "cpu",
    model: "base-model-from-ui-smoke",
    iterations: 3,
  });
  await expect(
    page.getByText("smoke-job-created", { exact: true }).first(),
  ).toBeVisible();
  await expectAnyTextareaValue(page, /started via Playwright/);

  await clickRequired(
    page.getByRole("button", {
      name: uiLabelPattern("Cancel", "finetuningview.Cancel"),
    }),
    "cancel running training job",
  );
  await expect
    .poll(() => recorder.cancelJobRequests())
    .toContain("smoke-job-created");
  await expect(page.getByText(/cancelled/i).first()).toBeVisible();

  await expectNoPageDiagnostics(page, "fine-tuning interactions");
});

test("trajectory viewer route refreshes, filters, and changes selected detail", async ({
  page,
}) => {
  const recorder = await installTrajectoryViewerInteractionRoutes(page);
  await openRouteCase(page, routeCaseByName("trajectories app window"));

  await expect(page.getByTestId("trajectories-view")).toBeVisible();
  let sidebar = await openVisiblePageSidebar(page, "trajectories-sidebar");
  await expect(sidebar.getByText("scenario-alpha")).toBeVisible();
  const listCount = recorder.listRequestCount();
  await clickRequired(
    sidebar.locator("button[title]").first(),
    "trajectory refresh",
  );
  await expect
    .poll(() => recorder.listRequestCount())
    .toBeGreaterThan(listCount);
  await closeMobilePageSidebar(page);

  await expect(page.getByText("deterministic-model-a").first()).toBeVisible();
  await expect(
    page
      .getByText("Alpha response from Playwright trajectory fixture.")
      .first(),
  ).toBeVisible();

  await clickRequired(
    page.getByRole("button", { name: /Plan/i }),
    "plan pipeline stage",
  );
  await expect(page.getByText(/Showing 1 plan calls/i)).toBeVisible();

  sidebar = await openVisiblePageSidebar(page, "trajectories-sidebar");
  await clickRequired(
    sidebar.getByText("scenario-beta"),
    "beta trajectory row",
  );
  await expect
    .poll(() => recorder.detailRequests().includes("traj-beta"))
    .toBe(true);
  await closeMobilePageSidebar(page);
  await expect(page.getByText("deterministic-model-b").first()).toBeVisible();
  await expect(
    page.getByText("Beta response from Playwright trajectory fixture.").first(),
  ).toBeVisible();

  sidebar = await openVisiblePageSidebar(page, "trajectories-sidebar");
  await sidebar
    .getByPlaceholder(uiLabelPattern("Search", "trajectoriesview.Search"))
    .fill("beta");
  await expect.poll(() => recorder.listRequests().at(-1)?.search).toBe("beta");
  await expect(sidebar.getByText("scenario-beta")).toBeVisible();
  await expect(sidebar.getByText("scenario-alpha")).toHaveCount(0);

  await expectNoPageDiagnostics(page, "trajectory viewer interactions");
});
