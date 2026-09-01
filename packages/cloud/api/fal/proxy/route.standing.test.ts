/** Proves fal.ai mutations stop at the shared standing gate before pricing or dispatch. */

import { expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { ApiError } from "@/lib/api/cloud-worker-errors";

const invokeFalProxy = mock(
  async () => new Response("upstream", { status: 200 }),
);

mock.module("@fal-ai/server-proxy", () => ({
  DEFAULT_ALLOWED_URL_PATTERNS: [],
  TARGET_URL_HEADER: "x-fal-target-url",
  getEndpoint: (value: string) => value,
  resolveApiKeyFromEnv: () => "unused",
}));
mock.module("@fal-ai/server-proxy/hono", () => ({
  createRouteHandler: () => invokeFalProxy,
}));
mock.module("@/api-app/lib/generative-route-auth", () => ({
  admitFlatGenerativeOperation: mock(async () => {
    throw new Error("admission must not run after standing denial");
  }),
  asGenerativeCacheApiError: () => null,
  getGenerativeExecutionContext: () => undefined,
  requireGenerativeRouteCaller: mock(async () => {
    throw new ApiError(403, "access_denied", "Account is inactive", {
      reason: "account_inactive",
    });
  }),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(() => undefined) },
}));

const { default: falRoute } = await import("./route");
const app = new Hono().route("/fal/proxy", falRoute);

test("standing denial prevents fal pricing, credit admission, and provider dispatch", async () => {
  const response = await app.request("/fal/proxy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fal-target-url": "fal-ai/test",
    },
    body: "{}",
  });

  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({
    code: "access_denied",
    error: "Account is inactive",
    details: { reason: "account_inactive" },
  });
  expect(invokeFalProxy).not.toHaveBeenCalled();
});
