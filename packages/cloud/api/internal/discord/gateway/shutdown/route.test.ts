/**
 * Discord gateway shutdown body validation.
 *
 * Exercises the REAL route module (`./route`) with its auth and repository
 * dependencies mocked via `mock.module`. The repository mock keeps a call
 * ledger so assertions check both the response and whether the mutation ran.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const releaseCalls: Array<{ podName: string }> = [];

mock.module("../../../_auth", () => ({
  requireInternalAuth: async () => ({
    podName: "pod-1",
    service: "test-service",
  }),
}));

mock.module("@/db/repositories/discord-connections", () => ({
  discordConnectionsRepository: {
    clearPodAssignments: async (podName: string) => {
      releaseCalls.push({ podName });
      return 3;
    },
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error() {},
    warn() {},
    info() {},
  },
}));

const { default: shutdownRoute } = await import("./route");

const app = new Hono().route(
  "/api/internal/discord/gateway/shutdown",
  shutdownRoute,
);

function post(body?: string): Promise<Response> {
  return app.request("/api/internal/discord/gateway/shutdown", {
    method: "POST",
    ...(body === undefined
      ? {}
      : { body, headers: { "content-type": "application/json" } }),
  });
}

beforeEach(() => {
  releaseCalls.length = 0;
});

describe("discord gateway shutdown body validation", () => {
  test("rejects a truncated non-empty body before any release", async () => {
    const response = await post('{"pod_name":');
    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      success?: boolean;
      error?: string;
    };
    expect(payload.success).toBe(false);
    expect(payload.error ?? "").toContain("not valid JSON");
    expect(releaseCalls).toEqual([]);
  });

  test("keeps the empty-body release-the-caller-pod contract", async () => {
    const response = await post("");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      success?: boolean;
      released?: number;
    };
    expect(payload).toEqual({ success: true, released: 3 });
    expect(releaseCalls).toEqual([{ podName: "pod-1" }]);
  });

  test("keeps the whitespace-only body contract", async () => {
    const response = await post("   ");
    expect(response.status).toBe(200);
    expect(releaseCalls).toEqual([{ podName: "pod-1" }]);
  });

  test("forwards an explicit pod name without inventing defaults", async () => {
    const response = await post(JSON.stringify({ pod_name: "pod-9" }));
    expect(response.status).toBe(200);
    expect(releaseCalls).toEqual([{ podName: "pod-9" }]);
  });

  test("still rejects schema-invalid JSON with 400 and no release", async () => {
    const response = await post(JSON.stringify({ pod_name: "not valid!!" }));
    expect(response.status).toBe(400);
    expect(releaseCalls).toEqual([]);
  });
});
