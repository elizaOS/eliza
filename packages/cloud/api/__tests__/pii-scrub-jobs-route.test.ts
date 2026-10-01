// Verifies the PII scrub enqueue route refuses server_discovery when no discovery handler exists.
import { describe, expect, mock, test } from "bun:test";
import type { MiddlewareHandler } from "hono";

mock.module("@/lib/utils/logger", () => ({
  logger: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
}));

const { createPiiScrubJobsRoute } = await import("../v1/pii-scrub/jobs/route");

const USER = {
  id: "00000000-0000-4000-8000-000000000009",
  organization_id: "00000000-0000-4000-8000-000000000001",
};
const passthrough: MiddlewareHandler = async (_c, next) => {
  await next();
};

function route(serverDiscoveryAvailable: boolean) {
  const enqueued: unknown[] = [];
  const app = createPiiScrubJobsRoute({
    requireUserOrApiKeyWithOrg: (async () => USER) as never,
    rateLimit: (() => passthrough) as never,
    enqueuePiiScrubBatch: (async (params: unknown) => {
      enqueued.push(params);
      return {
        id: "00000000-0000-4000-8000-00000000000a",
        status: "pending",
        attempts: 0,
        max_attempts: 3,
        result: null,
        error: null,
        data: params,
        created_at: new Date(0),
        started_at: null,
        completed_at: null,
        estimated_completion_at: null,
      };
    }) as never,
    serverDiscoveryAvailable: () => serverDiscoveryAvailable,
  });
  return { app, enqueued };
}

function post(app: ReturnType<typeof route>["app"], body: unknown) {
  return app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ITEMS = [{ itemRef: "row-1", content: "Call Alice." }];

describe("POST /api/v1/pii-scrub/jobs inspection scope", () => {
  test("server_discovery without a handler is refused with 422 and nothing is enqueued", async () => {
    const { app, enqueued } = route(false);
    const response = await post(app, {
      rulesetVersion: "r1",
      inspectionScope: "server_discovery",
      items: ITEMS,
    });
    expect(response.status).toBe(422);
    expect(enqueued).toHaveLength(0);
  });

  test("declared candidates enqueue and report the scope", async () => {
    const { app, enqueued } = route(false);
    const response = await post(app, { rulesetVersion: "r1", items: ITEMS });
    expect(response.status).toBe(202);
    expect(enqueued).toEqual([
      expect.objectContaining({ inspectionScope: undefined }),
    ]);
  });

  test("server_discovery enqueues when a handler is available", async () => {
    const { app, enqueued } = route(true);
    const response = await post(app, {
      rulesetVersion: "r1",
      inspectionScope: "server_discovery",
      items: ITEMS,
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      job: { inspectionScope: string };
    };
    expect(body.job.inspectionScope).toBe("server_discovery");
    expect(enqueued).toEqual([
      expect.objectContaining({ inspectionScope: "server_discovery" }),
    ]);
  });
});
