/** Verifies the thin inference router's authentication and canonical route behavior. */
import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@/types/cloud-worker-env";
import chatCompletionsRoute from "../v1/chat/completions/route";
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

function createChatInferenceApp() {
  return createInferenceApp("/api/v1/chat/completions", chatCompletionsRoute);
}

describe("chat-only inference application", () => {
  test("keeps unauthenticated chat pre-SSE with the canonical shell", async () => {
    const response = await createChatInferenceApp().fetch(
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
    // The 600/min global gate is the only native limiter left on the thin app:
    // #17805 retired the 200/min per-route chat gate in favor of org-level
    // limits carried by the IAC v2 admission snapshot.
    expect(response.headers.get("x-ratelimit-limit")).toBe("600");
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
    const response = await createChatInferenceApp().fetch(
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
    const response = await createChatInferenceApp().fetch(
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

  test("uses only the global native limiter when Railway Redis is unavailable in production", async () => {
    const globalKeys: string[] = [];
    const routeKeys: string[] = [];
    const response = await createChatInferenceApp().fetch(
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
        GLOBAL_RATE_LIMITER: {
          async limit({ key }: { key: string }) {
            globalKeys.push(key);
            return { success: true };
          },
        },
        CHAT_ROUTE_RATE_LIMITER: {
          async limit({ key }: { key: string }) {
            routeKeys.push(key);
            return { success: true };
          },
        },
      },
      executionCtx,
    );

    expect(response.status).toBe(401);
    expect(globalKeys).toHaveLength(1);
    // #17805 retired the per-route native chat gate from the hot path; even a
    // bound limiter must never be consulted by the thin inference app.
    expect(routeKeys).toHaveLength(0);
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
