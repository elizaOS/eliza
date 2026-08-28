/**
 * Playwright UI-smoke spec for the Apps Model Training Interactions app flow
 * using the real renderer fixture.
 */
import {
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import { DIRECT_ROUTE_CASES } from "./apps-session-route-cases";
import {
  assertReadyChecks,
  expectNoPageDiagnostics,
  hideChatOverlay,
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
        {
          ...trajectoryLlmCall(
            `${record.id}-plan`,
            record.id,
            "response",
            alpha ? "deterministic-model-a" : "deterministic-model-b",
            "Alpha response from Playwright trajectory fixture.",
            ["plan"],
          ),
          // The beta plan call is the sparse recorded shape the viewer has to
          // render truthfully: a whitespace-only primary prompt, an empty
          // response string, and falsy-but-real `0`/`false` fallbacks.
          ...(alpha
            ? {}
            : {
                userPrompt: "   ",
                prompt: 0,
                response: "",
                output: false,
              }),
        },
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
  await hideChatOverlay(page);
  await seedAppStorage(page, {
    "eliza:ui-theme": "dark",
    "elizaos:ui-theme": "dark",
    "eliza:page-sidebar:trajectories:width": "260",
    "elizaos:ui:sidebar:eliza:page-sidebar:trajectories:collapsed": "false",
  });
  await installDefaultAppRoutes(page);
});

test("trajectory viewer route refreshes, filters, and changes selected detail", async ({
  page,
}) => {
  const recorder = await installTrajectoryViewerInteractionRoutes(page);
  await openRouteCase(page, routeCaseByName("trajectories app window"));

  await expect(page.getByTestId("trajectories-view")).toBeVisible();
  await expect(
    page.getByText("chat / scenario-alpha / batch-ui-smoke"),
  ).toBeVisible();
  // The minimal redesign dropped the manual Refresh button: the list stays
  // current via a silent ~15s background poll. Assert the poll re-queries the
  // list source (no user-facing refresh control).
  const listCount = recorder.listRequestCount();
  await expect
    .poll(() => recorder.listRequestCount(), { timeout: 30_000 })
    .toBeGreaterThan(listCount);
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

  await clickRequired(
    page.getByText("orchestrator / scenario-beta / batch-ui-smoke"),
    "beta trajectory row",
  );
  await expect
    .poll(() => recorder.detailRequests().includes("traj-beta"))
    .toBe(true);
  await expect(page.getByText("deterministic-model-b").first()).toBeVisible();
  const sparseInput = page.getByRole("region", { name: "Input (User)" });
  const sparseOutput = page.getByRole("region", {
    name: "Output (Response)",
  });
  await expect(sparseInput).toHaveText("0");
  await expect(sparseOutput).toHaveText("false");
  await expect(
    page.getByText("1 lines", { exact: true }).first(),
  ).toBeVisible();

  // NOTE: the trajectories list search moved to the floating chat composer.
  // This suite hides that overlay in beforeEach (it floats over the viewer), so
  // the chat-driven search is exercised by the dedicated builtin-pages spec
  // ("trajectories view loads and search re-queries"), not here.

  await expectNoPageDiagnostics(page, "trajectory viewer interactions");
});
