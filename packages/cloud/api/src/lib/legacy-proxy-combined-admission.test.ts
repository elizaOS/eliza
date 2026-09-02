/**
 * Behavioral contract for the paid legacy-proxy combined-admission adapter.
 * Standing is read once; combined Worker mode never falls back to generic
 * auth/reserve; provider dispatch is not invoked before a snapshot is forwarded.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { ApiError } from "@/lib/api/cloud-worker-errors";

type CombinedCaller = {
  user: { id: string; organization_id: string };
  apiKeyId: string | null;
  authSource: "combined_cache";
  admissionSnapshot?: {
    balance: { balanceUsd: number; balanceAt: number; balanceRevision: string };
    rateLimits: {
      completionsRpm: number;
      embeddingsRpm: number;
      standardRpm: number;
      strictRpm: number;
    };
  };
  appScopeId: string | null;
};

const requireGenerativeRouteCaller = mock(async (): Promise<CombinedCaller> => ({
  user: { id: "user-1", organization_id: "org-1" },
  apiKeyId: "key-1",
  authSource: "combined_cache",
  admissionSnapshot: {
    balance: { balanceUsd: 10, balanceAt: 1, balanceRevision: "1" },
    rateLimits: {
      completionsRpm: 1,
      embeddingsRpm: 1,
      standardRpm: 1,
      strictRpm: 1,
    },
  },
  appScopeId: null,
}));
const getGenerativeExecutionContext = mock(
  (): { waitUntil(promise: Promise<unknown>): void } | undefined => ({
    waitUntil: () => undefined,
  }),
);
const executeWithBody = mock(async () => Response.json({ ok: true }));

mock.module("@/api-app/lib/generative-route-auth", () => ({
  requireGenerativeRouteCaller,
  getGenerativeExecutionContext,
  asGenerativeCacheApiError: () => null,
}));
mock.module("@/lib/services/proxy/engine", () => ({
  executeWithBody,
}));

const {
  executePaidProxyWithCombinedAdmission,
  resolvePaidProxyCombinedAdmission,
} = await import("./legacy-proxy-combined-admission");

const config = { id: "market-data", name: "Market Data" };
const work = mock(async () => ({ response: Response.json({ ok: true }) }));
const body = { method: "getPrice", chain: "solana", params: { address: "x" } };

const app = new Hono();
app.post("/paid", async (c) =>
  executePaidProxyWithCombinedAdmission(
    c as never,
    config as never,
    work as never,
    c.req.raw,
    body,
  ),
);

beforeEach(() => {
  requireGenerativeRouteCaller.mockClear();
  getGenerativeExecutionContext.mockClear();
  executeWithBody.mockClear();
  work.mockClear();
  requireGenerativeRouteCaller.mockResolvedValue({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: "key-1",
    authSource: "combined_cache",
    admissionSnapshot: {
      balance: { balanceUsd: 10, balanceAt: 1, balanceRevision: "1" },
      rateLimits: {
        completionsRpm: 1,
        embeddingsRpm: 1,
        standardRpm: 1,
        strictRpm: 1,
      },
    },
    appScopeId: null,
  });
  getGenerativeExecutionContext.mockReturnValue({
    waitUntil: () => undefined,
  });
  executeWithBody.mockResolvedValue(Response.json({ ok: true }));
});

describe("paid legacy proxy combined admission adapter", () => {
  test("forwards the combined snapshot and credential after one standing read", async () => {
    const response = await app.request("/paid", { method: "POST" });
    expect(response.status).toBe(200);
    expect(requireGenerativeRouteCaller).toHaveBeenCalledTimes(1);
    expect(executeWithBody).toHaveBeenCalledTimes(1);
    const forwarded = (
      executeWithBody.mock.calls as unknown as Array<
        [
          unknown,
          unknown,
          unknown,
          unknown,
          {
            auth: {
              user: { id: string; organization_id: string };
              apiKey?: { id: string };
            };
            admissionSnapshot: unknown;
            requestId: string;
          },
        ]
      >
    )[0][4];
    expect(forwarded.auth.user).toEqual({
      id: "user-1",
      organization_id: "org-1",
    });
    expect(forwarded.auth.apiKey).toEqual({ id: "key-1" });
    expect(forwarded.admissionSnapshot).toBeDefined();
    expect(forwarded.requestId.length).toBeGreaterThan(0);
    expect(work).not.toHaveBeenCalled();
  });

  test("preserves safe standing denial reasons without dispatch", async () => {
    requireGenerativeRouteCaller.mockRejectedValueOnce(
      new ApiError(403, "access_denied", "Organization is inactive", {
        reason: "organization_inactive",
      }),
    );
    const response = await app.request("/paid", { method: "POST" });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: "access_denied",
      error: "Organization is inactive",
      details: { reason: "organization_inactive" },
    });
    expect(executeWithBody).not.toHaveBeenCalled();
    expect(requireGenerativeRouteCaller).toHaveBeenCalledTimes(1);
  });

  test("combined mode without a snapshot returns 503 and never dispatches", async () => {
    requireGenerativeRouteCaller.mockResolvedValueOnce({
      user: { id: "user-1", organization_id: "org-1" },
      apiKeyId: null,
      authSource: "combined_cache",
      appScopeId: null,
    });
    const response = await app.request("/paid", { method: "POST" });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: "service_unavailable",
    });
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(executeWithBody).not.toHaveBeenCalled();
  });

  test("resolvePaidProxyCombinedAdmission calls requireGenerativeRouteCaller once", async () => {
    const c = {
      get: (key: string) => (key === "requestId" ? "req-1" : undefined),
      req: { raw: new Request("https://api.test/paid") },
    };
    const admission = await resolvePaidProxyCombinedAdmission(c as never);
    expect(requireGenerativeRouteCaller).toHaveBeenCalledTimes(1);
    expect(admission.auth.user.organization_id).toBe("org-1");
    expect(admission.requestId).toBe("req-1");
  });
});
