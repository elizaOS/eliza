import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@/types/cloud-worker-env";
import { createInferenceApp } from "./inference-app";

const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

const env = {
  ENVIRONMENT: "test",
  NODE_ENV: "test",
  REDIS_RATE_LIMITING: "false",
  CACHE_ENABLED: "false",
  BLOB: {},
} as unknown as AppEnv["Bindings"];

describe("chat-only inference application", () => {
  test("keeps unauthenticated chat pre-SSE with the canonical shell", async () => {
    const response = await createInferenceApp().fetch(
      new Request("https://api.elizacloud.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gemma-4-31b",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      env,
      executionCtx,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("strict-transport-security")).toContain(
      "max-age=63072000",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-ratelimit-limit")).toBe("200");
    expect(await response.json()).toEqual({
      error: {
        message: "Authentication required",
        type: "authentication_error",
      },
    });
  });

  test("keeps CORS preflight ahead of route auth", async () => {
    const response = await createInferenceApp().fetch(
      new Request("https://api.elizacloud.ai/api/v1/chat/completions", {
        method: "OPTIONS",
        headers: {
          origin: "https://elizacloud.ai",
          "access-control-request-method": "POST",
        },
      }),
      env,
      executionCtx,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
  });
});
