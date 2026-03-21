import { describe, expect, test, vi } from "vitest";
import type { TriggerRouteContext } from "../../src/api/trigger-routes";
import { handleTriggerRoutes } from "../../src/api/trigger-routes";
import {
  createMockHttpResponse,
  createMockIncomingMessage,
} from "../../src/test-support/test-helpers";

function buildCtx(
  overrides: Partial<TriggerRouteContext> = {},
): TriggerRouteContext {
  const { res } = createMockHttpResponse();
  return {
    req: createMockIncomingMessage({ method: "GET", url: "/" }),
    res,
    method: "GET",
    pathname: "/",
    json: vi.fn((r, data, status = 200) => {
      r.writeHead(status);
      r.end(JSON.stringify(data));
    }),
    error: vi.fn((r, message, status = 500) => {
      r.writeHead(status);
      r.end(JSON.stringify({ error: message }));
    }),
    readJsonBody: vi.fn(async () => null),
    runtime: null,
    executeTriggerTask: vi.fn(),
    getTriggerHealthSnapshot: vi.fn(async () => ({ healthy: true })),
    getTriggerLimit: vi.fn(() => 10),
    listTriggerTasks: vi.fn(async () => []),
    readTriggerConfig: vi.fn(() => null),
    readTriggerRuns: vi.fn(() => []),
    taskToTriggerSummary: vi.fn(() => null),
    triggersFeatureEnabled: vi.fn(() => true),
    buildTriggerConfig: vi.fn(),
    buildTriggerMetadata: vi.fn(() => null),
    normalizeTriggerDraft: vi.fn(() => ({ draft: undefined, error: "noop" })),
    DISABLED_TRIGGER_INTERVAL_MS: 86_400_000,
    TRIGGER_TASK_NAME: "trigger",
    TRIGGER_TASK_TAGS: ["trigger"],
    ...overrides,
  };
}

describe("handleTriggerRoutes", () => {
  test("returns false for unrelated path", async () => {
    const ctx = buildCtx({ pathname: "/api/other" });
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(false);
  });

  test("returns 503 when runtime is null", async () => {
    const { res, getStatus, getJson } = createMockHttpResponse();
    const ctx = buildCtx({
      method: "GET",
      pathname: "/api/triggers",
      res,
      runtime: null,
    });

    const handled = await handleTriggerRoutes(ctx);

    expect(handled).toBe(true);
    expect(getStatus()).toBe(503);
    expect(getJson()).toEqual({ error: "Agent is not running" });
  });

  test("GET /api/triggers/health returns snapshot even without runtime features enabled", async () => {
    const { res, getStatus, getJson } = createMockHttpResponse();
    const snapshot = { healthy: true, triggers: 0 };
    const ctx = buildCtx({
      method: "GET",
      pathname: "/api/triggers/health",
      res,
      runtime: {} as TriggerRouteContext["runtime"],
      triggersFeatureEnabled: vi.fn(() => false),
      getTriggerHealthSnapshot: vi.fn(async () => snapshot),
    });

    const handled = await handleTriggerRoutes(ctx);

    expect(handled).toBe(true);
    expect(getStatus()).toBe(200);
    expect(getJson()).toEqual(snapshot);
  });
});
