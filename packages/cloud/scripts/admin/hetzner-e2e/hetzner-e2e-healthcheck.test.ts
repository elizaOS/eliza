/**
 * Hetzner bridge health polling tests explicit Cloud warming behavior through
 * deterministic fetch responses without provisioning infrastructure.
 */

import { describe, expect, test } from "bun:test";
import { runHealthcheck } from "./hetzner-e2e-healthcheck";

const options = {
  apiKey: "test-api-key",
  baseUrl: "https://cloud.example.test",
  agentId: "agent-test",
  retryDelayMs: 0,
};

describe("Hetzner E2E bridge healthcheck", () => {
  test("retries an explicit warming response until the bridge is ready", async () => {
    const responses = [
      new Response(
        JSON.stringify({
          success: false,
          error: "Agent authorization cache is warming. Retry shortly.",
          retryable: true,
        }),
        { status: 503 },
      ),
      Response.json({ result: { ready: true } }),
    ];
    const delays: number[] = [];

    await runHealthcheck({
      ...options,
      maxAttempts: 2,
      fetchBridge: async () => {
        const response = responses.shift();
        if (!response) throw new Error("unexpected fetch");
        return response;
      },
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    expect(responses).toHaveLength(0);
    expect(delays).toEqual([0]);
  });

  test("fails immediately on a non-retryable HTTP response", async () => {
    let calls = 0;

    await expect(
      runHealthcheck({
        ...options,
        maxAttempts: 3,
        fetchBridge: async () => {
          calls += 1;
          return Response.json(
            { success: false, error: "Forbidden", retryable: false },
            { status: 403 },
          );
        },
        sleep: async () => {
          throw new Error("non-retryable response must not sleep");
        },
      }),
    ).rejects.toThrow("Healthcheck HTTP 403");
    expect(calls).toBe(1);
  });

  test("does not retry a non-warming status even if its body claims retryable", async () => {
    let calls = 0;

    await expect(
      runHealthcheck({
        ...options,
        maxAttempts: 3,
        fetchBridge: async () => {
          calls += 1;
          return Response.json(
            { success: false, error: "Unauthorized", retryable: true },
            { status: 401 },
          );
        },
        sleep: async () => {
          throw new Error("non-warming status must not sleep");
        },
      }),
    ).rejects.toThrow("Healthcheck HTTP 401");
    expect(calls).toBe(1);
  });

  test("fails after the bounded warming retry budget is exhausted", async () => {
    let calls = 0;

    await expect(
      runHealthcheck({
        ...options,
        maxAttempts: 3,
        fetchBridge: async () => {
          calls += 1;
          return Response.json(
            { success: false, error: "Still warming", retryable: true },
            { status: 503 },
          );
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow("Healthcheck HTTP 503");
    expect(calls).toBe(3);
  });

  test("does not retry a malformed error body", async () => {
    let calls = 0;

    await expect(
      runHealthcheck({
        ...options,
        maxAttempts: 3,
        fetchBridge: async () => {
          calls += 1;
          return new Response("not-json", { status: 503 });
        },
        sleep: async () => {
          throw new Error("invalid response must not sleep");
        },
      }),
    ).rejects.toThrow("Healthcheck HTTP 503: not-json");
    expect(calls).toBe(1);
  });

  test("rejects an invalid retry budget instead of succeeding without a ping", async () => {
    await expect(
      runHealthcheck({
        ...options,
        maxAttempts: 0,
        fetchBridge: async () => {
          throw new Error("invalid budget must fail before fetching");
        },
      }),
    ).rejects.toThrow("Healthcheck maxAttempts must be positive: 0");
  });
});
