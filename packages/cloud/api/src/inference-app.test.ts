import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@/types/cloud-worker-env";
import { createInferenceApp } from "./inference-app";

interface AuthErrorBody {
  error: {
    message: string;
    type: string;
    code: string;
  };
}

interface NotFoundBody {
  success: false;
  error: string;
  code: string;
}

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
    const body = (await response.json()) as AuthErrorBody;
    expect(body).toEqual({
      error: {
        message: "Authentication required.",
        type: "authentication_error",
        code: "authentication_required",
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

  test("keeps non-chat routes outside the thin app surface", async () => {
    const response = await createInferenceApp().fetch(
      new Request("https://api.elizacloud.ai/api/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "embedding-model", input: "hi" }),
      }),
      env,
      executionCtx,
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as NotFoundBody;
    expect(body).toEqual({
      success: false,
      error: "Not found",
      code: "resource_not_found",
    });
  });

  test("uses native limiters when Railway Redis is unavailable in production", async () => {
    const nativeKeys: string[] = [];
    const nativeLimiter = {
      async limit({ key }: { key: string }) {
        nativeKeys.push(key);
        return { success: true };
      },
    };
    const response = await createInferenceApp().fetch(
      new Request("https://api.elizacloud.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gemma-4-31b",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      {
        ...env,
        ENVIRONMENT: "production",
        NODE_ENV: "production",
        REDIS_RATE_LIMITING: "true",
        GLOBAL_RATE_LIMITER: nativeLimiter,
        CHAT_ROUTE_RATE_LIMITER: nativeLimiter,
      },
      executionCtx,
    );

    expect(response.status).toBe(401);
    expect(nativeKeys).toHaveLength(2);
    const body = (await response.json()) as AuthErrorBody;
    expect(body).toEqual({
      error: {
        message: "Authentication required.",
        type: "authentication_error",
        code: "authentication_required",
      },
    });
  });
});
