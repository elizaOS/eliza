/**
 * Exercises the complete shared staging smoke through a deterministic HTTP
 * contract harness. The harness drives the real runner and request bodies; it
 * substitutes only the remote staging boundary, so no credential, provider
 * call, agent row, container, or billable resource is created.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isExactSharedSmokeStagingOrigin,
  runSharedStagingOnboardingSmoke,
} from "./live-cloud-provision-smoke";

type JsonObject = Record<string, unknown>;

const BASE_URL = "https://api-staging.eliza.app";
const SUFFIX = "run12345";
const AGENT_ID = "agent-shared-123";
const AGENT_NAME = `shared-staging-smoke-${SUFFIX}`;
const CREATED_AT = "2026-08-09T18:00:00.000Z";
const DEPLOY_COMMIT = "a".repeat(40);

interface RequestRecord {
  url: string;
  method: string;
  headers: Headers;
  redirect: RequestRedirect | undefined;
  body: JsonObject | null;
}

interface HarnessOptions {
  asyncDelete?: boolean;
  bridgeReply?:
    | "valid"
    | "invalid"
    | "warming-once"
    | "warming-always"
    | "foreign-retryable-503";
  bridgeDelayMs?: number;
  cleanupDelete?: "success" | "fail" | "retain";
  create?:
    | "fresh"
    | "fresh-http-200"
    | "fresh-http-202"
    | "fresh-wrong-name"
    | "malformed-201"
    | "idempotent-race"
    | "wrong-tier"
    | "throw-after-commit"
    | "throw-without-commit";
  existingPreflight?: JsonObject[];
  pairing?: "negative" | "positive";
  retryAfter?: string;
  sseReply?: "valid" | "invalid" | "warming-once" | "malformed-503";
}

function requestBody(init: RequestInit | undefined): JsonObject | null {
  if (typeof init?.body !== "string") return null;
  return JSON.parse(init.body) as JsonObject;
}

function tokenFromBody(body: JsonObject | null, prefix: string): string {
  const params = body?.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return "";
  const text = (params as JsonObject).text;
  if (typeof text !== "string") return "";
  return text.match(new RegExp(`${prefix}[a-z0-9]+`))?.[0] ?? "";
}

function identity(tier = "shared"): JsonObject {
  return {
    id: AGENT_ID,
    agentId: AGENT_ID,
    agentName: AGENT_NAME,
    createdAt: CREATED_AT,
    executionTier: tier,
    status: "running",
    databaseStatus: "ready",
  };
}

function identityWithName(name: string, tier = "shared"): JsonObject {
  return { ...identity(tier), agentName: name };
}

function makeHarness(options: HarnessOptions = {}) {
  const requests: RequestRecord[] = [];
  let clock = 1_000;
  let agentExists = false;
  let bridgeAttempts = 0;
  let sseAttempts = 0;
  const sleeps: number[] = [];
  const agentTier =
    options.create === "wrong-tier" ? "dedicated-lazy" : "shared";
  const createdAgentName =
    options.create === "fresh-wrong-name"
      ? "unexpected-created-name"
      : AGENT_NAME;
  let preflightComplete = false;

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const parsedUrl = new URL(url);
    const method = init?.method ?? "GET";
    const body = requestBody(init);
    requests.push({
      url,
      method,
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
      body,
    });

    if (parsedUrl.pathname === "/api/health" && method === "GET") {
      return Response.json({
        status: "ok",
        region: "test",
        commit: DEPLOY_COMMIT,
      });
    }

    if (parsedUrl.pathname === "/api/v1/eliza/agents" && method === "GET") {
      if (!preflightComplete) {
        preflightComplete = true;
        return Response.json({ data: options.existingPreflight ?? [] });
      }
      return Response.json({
        data: agentExists
          ? [identityWithName(createdAgentName, agentTier)]
          : [],
      });
    }

    if (parsedUrl.pathname === "/api/v1/eliza/agents" && method === "POST") {
      if (options.create === "idempotent-race") {
        agentExists = true;
        return Response.json({
          success: true,
          created: false,
          data: identity(),
        });
      }
      if (options.create === "throw-after-commit") {
        agentExists = true;
        throw new Error("simulated response loss");
      }
      if (options.create === "throw-without-commit") {
        throw new Error("simulated pre-commit failure");
      }
      agentExists = true;
      if (options.create === "malformed-201") {
        return Response.json({}, { status: 201 });
      }
      return Response.json(
        {
          success: true,
          created: true,
          source: "shared_runtime",
          data:
            options.create === "fresh-wrong-name"
              ? identityWithName("unexpected-created-name", agentTier)
              : identity(agentTier),
        },
        {
          status:
            options.create === "fresh-http-200"
              ? 200
              : options.create === "fresh-http-202"
                ? 202
                : 201,
        },
      );
    }

    if (
      parsedUrl.pathname === `/api/v1/eliza/agents/${AGENT_ID}/provision` &&
      method === "POST"
    ) {
      return Response.json({
        success: true,
        source: "shared_runtime",
        data: identity(agentTier),
      });
    }

    if (
      parsedUrl.pathname === `/api/v1/eliza/agents/${AGENT_ID}/bridge` &&
      method === "POST"
    ) {
      bridgeAttempts += 1;
      clock += options.bridgeDelayMs ?? 0;
      if (
        options.bridgeReply === "warming-always" ||
        (options.bridgeReply === "warming-once" && bridgeAttempts === 1)
      ) {
        return Response.json(
          {
            success: false,
            error: "Shared runtime cache is warming. Retry shortly.",
            code: "shared_runtime_cache_warming",
            retryable: true,
          },
          {
            status: 503,
            headers: { "Retry-After": options.retryAfter ?? "1" },
          },
        );
      }
      if (options.bridgeReply === "foreign-retryable-503") {
        return Response.json(
          {
            success: false,
            error: "Inference is unavailable.",
            code: "inference_unavailable",
            retryable: true,
          },
          { status: 503, headers: { "Retry-After": "1" } },
        );
      }
      const token = tokenFromBody(body, "shared-bridge-");
      return Response.json({
        jsonrpc: "2.0",
        id: body?.id,
        result: {
          text:
            options.bridgeReply === "invalid"
              ? "This response omitted the proof nonce."
              : `Shared reply includes ${token}.`,
          transport: "shared-runtime",
        },
      });
    }

    if (
      parsedUrl.pathname === `/api/v1/eliza/agents/${AGENT_ID}/stream` &&
      method === "POST"
    ) {
      sseAttempts += 1;
      if (options.sseReply === "malformed-503") {
        return new Response("not-json", {
          status: 503,
          headers: { "Retry-After": "1" },
        });
      }
      if (options.sseReply === "warming-once" && sseAttempts === 1) {
        return Response.json(
          {
            success: false,
            error: "Agent authorization cache is warming. Retry shortly.",
            code: "agent_cache_warming",
            retryable: true,
          },
          {
            status: 503,
            headers: { "Retry-After": options.retryAfter ?? "1" },
          },
        );
      }
      const token = tokenFromBody(body, "shared-sse-");
      const text =
        options.sseReply === "invalid"
          ? "This stream omitted the proof nonce."
          : `Shared stream includes ${token}.`;
      return new Response(
        `event: message\ndata: ${JSON.stringify({ text })}\n\nevent: done\ndata: {}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }

    if (
      parsedUrl.pathname === `/api/v1/eliza/agents/${AGENT_ID}/pairing-token` &&
      method === "POST"
    ) {
      if (options.pairing === "positive") {
        return Response.json({
          success: true,
          data: { token: "unexpected", redirectUrl: "https://example.test" },
        });
      }
      return Response.json(
        {
          success: false,
          code: "AGENT_WEB_UI_NOT_READY",
          error: "Shared agents have no dedicated Web UI.",
          retryable: true,
        },
        { status: 503 },
      );
    }

    if (
      parsedUrl.pathname === `/api/v1/eliza/agents/${AGENT_ID}` &&
      method === "GET"
    ) {
      return agentExists
        ? Response.json({
            success: true,
            data: identityWithName(createdAgentName, agentTier),
          })
        : Response.json(
            { success: false, error: "Agent not found" },
            { status: 404 },
          );
    }

    if (
      parsedUrl.pathname === `/api/v1/eliza/agents/${AGENT_ID}` &&
      method === "DELETE"
    ) {
      if (options.cleanupDelete === "fail") {
        return Response.json(
          { success: false, error: "delete failed" },
          { status: 500 },
        );
      }
      if (options.asyncDelete || agentTier !== "shared") {
        return Response.json(
          {
            success: true,
            created: true,
            data: { jobId: "delete-job-1", agentId: AGENT_ID },
          },
          { status: 202 },
        );
      }
      if (options.cleanupDelete !== "retain") agentExists = false;
      return Response.json({
        success: true,
        deleted: true,
        source: "shared_runtime",
        data: {
          agentId: AGENT_ID,
          status: "deleted",
          executionTier: agentTier,
        },
      });
    }

    if (parsedUrl.pathname === "/api/v1/jobs/delete-job-1") {
      if (options.cleanupDelete !== "retain") agentExists = false;
      return Response.json({
        success: true,
        data: { id: "delete-job-1", status: "completed" },
      });
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  return {
    requests,
    sleeps,
    options: {
      apiKey: "test-staging-key",
      baseUrl: BASE_URL,
      fetch: fetchImpl as typeof fetch,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += Math.max(1, ms);
      },
      suffix: SUFFIX,
      cleanupTimeoutMs: 5,
      totalTimeoutMs: 100_000,
      cleanupReserveMs: 20_000,
      createRecoveryTimeoutMs: 5,
      pollIntervalMs: 1,
    },
  };
}

describe("shared staging onboarding smoke", () => {
  test("accepts only the exact api-staging origin", () => {
    expect(isExactSharedSmokeStagingOrigin(BASE_URL)).toBe(true);
    for (const refused of [
      "https://api.eliza.app",
      "http://api-staging.eliza.app",
      "https://api-staging.eliza.app/",
      "https://api-staging.eliza.app/api",
      "https://api-staging.eliza.app?target=prod",
      "https://user@api-staging.eliza.app",
      "https://api-staging.eliza.app.evil.test",
    ]) {
      expect(isExactSharedSmokeStagingOrigin(refused), refused).toBe(false);
    }
  });

  test("passes the full fresh shared lifecycle and synchronous cleanup", async () => {
    const harness = makeHarness();
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence).toMatchObject({
      verdict: "pass",
      deployedCommit: DEPLOY_COMMIT,
      path: {
        requestedTier: "shared",
        observedTier: "shared",
        credentialPreflight: true,
        freshCreate: true,
        immediateProvision: true,
        bridgeTransport: "shared-runtime",
        bridgeReply: true,
        sseCompleted: true,
        pairingUnavailable: true,
        successfulPaths: 2,
      },
      capacity: {
        maxCreatedAgents: 1,
        createdAgents: 1,
        isolatedCredential: true,
      },
      cleanup: { status: "passed", possibleOrphan: false },
      failure: null,
    });

    const create = harness.requests.find(
      (request) =>
        request.method === "POST" &&
        new URL(request.url).pathname === "/api/v1/eliza/agents",
    );
    expect(create?.body).toMatchObject({
      agentName: AGENT_NAME,
      autoProvision: false,
      agentConfig: {
        username: AGENT_NAME,
        plugins: ["@elizaos/plugin-sql", "@elizaos/plugin-elizacloud"],
      },
    });
    expect(create?.body).not.toHaveProperty("alwaysOn");
    expect(create?.body).not.toHaveProperty("forceCreate");

    const deletion = harness.requests.find(
      (request) => request.method === "DELETE",
    );
    expect(deletion?.body).toEqual({
      expectedAgentName: AGENT_NAME,
      expectedCreatedAt: CREATED_AT,
      expectedExecutionTier: "shared",
    });
    expect(
      harness.requests.some(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/pairing-token"),
      ),
    ).toBe(true);
    expect(
      harness.requests.every(
        (request) =>
          request.url.startsWith(`${BASE_URL}/`) &&
          request.redirect === "error" &&
          request.headers.get("authorization") === "Bearer test-staging-key",
      ),
    ).toBe(true);
  });

  test("accepts the asynchronous conditional delete contract and final 404", async () => {
    const harness = makeHarness({ asyncDelete: true });
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence.verdict).toBe("pass");
    expect(evidence.cleanup).toEqual({
      status: "passed",
      possibleOrphan: false,
    });
    expect(
      harness.requests.some(
        (request) =>
          new URL(request.url).pathname === "/api/v1/jobs/delete-job-1",
      ),
    ).toBe(true);
    const finalRequest = harness.requests.at(-1);
    expect(finalRequest?.method).toBe("GET");
    if (!finalRequest) throw new Error("Expected final verification request");
    expect(new URL(finalRequest.url).pathname).toBe(
      `/api/v1/eliza/agents/${AGENT_ID}`,
    );
  });

  test("refuses production and a missing credential before any request", async () => {
    const production = makeHarness();
    const productionEvidence = await runSharedStagingOnboardingSmoke({
      ...production.options,
      baseUrl: "https://api.eliza.app",
    });
    expect(productionEvidence.failure).toEqual({
      phase: "config",
      code: "non_staging_target_refused",
    });
    expect(production.requests).toHaveLength(0);

    const keyless = makeHarness();
    const keylessEvidence = await runSharedStagingOnboardingSmoke({
      ...keyless.options,
      apiKey: "   ",
    });
    expect(keylessEvidence.failure).toEqual({
      phase: "config",
      code: "missing_cloud_credential",
    });
    expect(keyless.requests).toHaveLength(0);
  });

  test("requires an isolated credential before creating anything", async () => {
    const harness = makeHarness({
      existingPreflight: [
        {
          id: "pre-existing-agent",
          agentName: "do-not-touch",
          executionTier: "shared",
          createdAt: CREATED_AT,
        },
      ],
    });
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence.failure).toEqual({
      phase: "preflight",
      code: "credential_not_isolated",
    });
    expect(evidence.capacity.createdAgents).toBe(0);
    expect(harness.requests.some((request) => request.method === "POST")).toBe(
      false,
    );
    expect(
      harness.requests.some((request) => request.method === "DELETE"),
    ).toBe(false);
  });

  test("does not delete an idempotently reused agent after a concurrent race", async () => {
    const harness = makeHarness({ create: "idempotent-race" });
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence.failure).toEqual({
      phase: "create",
      code: "fresh_create_required",
    });
    expect(evidence.capacity.createdAgents).toBe(0);
    expect(evidence.cleanup).toEqual({
      status: "not-required",
      possibleOrphan: false,
    });
    expect(
      harness.requests.some((request) => request.method === "DELETE"),
    ).toBe(false);
  });

  test("cleans an explicit fresh row when the create HTTP status drifts", async () => {
    const harness = makeHarness({ create: "fresh-http-200" });
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence.failure).toEqual({
      phase: "create",
      code: "fresh_create_required",
    });
    expect(evidence.capacity.createdAgents).toBe(1);
    expect(evidence.cleanup.status).toBe("passed");
    expect(
      harness.requests.some((request) => request.method === "DELETE"),
    ).toBe(true);
  });

  test("cleans a parseable created:true row before rejecting its returned name", async () => {
    const harness = makeHarness({ create: "fresh-wrong-name" });
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence.failure).toEqual({
      phase: "create",
      code: "created_name_mismatch",
    });
    expect(evidence.capacity.createdAgents).toBe(1);
    expect(evidence.cleanup.status).toBe("passed");
    const deletion = harness.requests.find(
      (request) => request.method === "DELETE",
    );
    expect(deletion?.body).toMatchObject({
      expectedAgentName: "unexpected-created-name",
    });
  });

  test("recovers and cleans an unaccepted 2xx create status by exact name", async () => {
    const harness = makeHarness({ create: "fresh-http-202" });
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence.failure).toEqual({
      phase: "create",
      code: "unexpected_http_202",
    });
    expect(evidence.capacity.createdAgents).toBe(1);
    expect(evidence.cleanup.status).toBe("passed");
    expect(
      harness.requests.some((request) => request.method === "DELETE"),
    ).toBe(true);
  });

  test("recovers a committed 201 with a malformed create contract", async () => {
    const harness = makeHarness({ create: "malformed-201" });
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence.failure).toEqual({
      phase: "create",
      code: "invalid_create_contract",
    });
    expect(evidence.capacity.createdAgents).toBe(1);
    expect(evidence.cleanup.status).toBe("passed");
    expect(
      harness.requests.some((request) => request.method === "DELETE"),
    ).toBe(true);
  });

  test("retries only a structured bridge warming response and honors Retry-After", async () => {
    const harness = makeHarness({
      bridgeReply: "warming-once",
      retryAfter: "7",
    });
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence.verdict).toBe("pass");
    expect(evidence.capacity.chatRequests).toBe(3);
    expect(harness.sleeps).toContain(7_000);
    expect(evidence.capacity.chatRequests).toBeLessThanOrEqual(
      evidence.capacity.maxChatRequests,
    );
    expect(
      harness.requests.filter(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/pairing-token"),
      ),
    ).toHaveLength(1);
    expect(
      harness.requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(1);
    expect(evidence.path.pairingUnavailable).toBe(true);
    expect(evidence.cleanup).toEqual({
      status: "passed",
      possibleOrphan: false,
    });
  });

  test("retries structured SSE warming without consuming the bridge budget", async () => {
    const harness = makeHarness({ sseReply: "warming-once", retryAfter: "3" });
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence.verdict).toBe("pass");
    expect(evidence.capacity.chatRequests).toBe(3);
    expect(harness.sleeps).toContain(3_000);
    expect(evidence.path.successfulPaths).toBe(2);
    expect(evidence.path.pairingUnavailable).toBe(true);
    expect(evidence.cleanup).toEqual({
      status: "passed",
      possibleOrphan: false,
    });
  });

  test("fails closed without retrying a malformed SSE response and still cleans up", async () => {
    const harness = makeHarness({ sseReply: "malformed-503" });
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence.failure).toEqual({
      phase: "sse",
      code: "invalid_json_response_http_503",
    });
    expect(evidence.capacity.chatRequests).toBe(2);
    expect(
      harness.requests.filter(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/stream"),
      ),
    ).toHaveLength(1);
    expect(evidence.path.pairingUnavailable).toBe(false);
    expect(evidence.cleanup).toEqual({
      status: "passed",
      possibleOrphan: false,
    });
  });

  test("does not retry a non-warming retryable 503", async () => {
    const harness = makeHarness({ bridgeReply: "foreign-retryable-503" });
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence.failure).toEqual({
      phase: "bridge",
      code: "unexpected_http_503",
    });
    expect(evidence.capacity.chatRequests).toBe(1);
    expect(harness.sleeps).not.toContain(1_000);
    expect(evidence.path.pairingUnavailable).toBe(false);
    expect(evidence.cleanup).toEqual({
      status: "passed",
      possibleOrphan: false,
    });
  });

  test("bounds repeated structured warming and still performs exact cleanup", async () => {
    const harness = makeHarness({
      bridgeReply: "warming-always",
      retryAfter: "0",
    });
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence.failure).toEqual({
      phase: "bridge",
      code: "unexpected_http_503",
    });
    expect(evidence.capacity.chatRequests).toBe(
      evidence.capacity.maxChatRequests / 2,
    );
    expect(evidence.path.pairingUnavailable).toBe(false);
    expect(evidence.cleanup).toEqual({
      status: "passed",
      possibleOrphan: false,
    });
  });

  test("reserves cleanup capacity when the operation deadline is exhausted", async () => {
    const harness = makeHarness({
      bridgeReply: "warming-once",
      bridgeDelayMs: 80,
    });
    const evidence = await runSharedStagingOnboardingSmoke({
      ...harness.options,
      totalTimeoutMs: 100,
      cleanupReserveMs: 20,
      cleanupTimeoutMs: 20,
    });

    expect(evidence.failure).toEqual({
      phase: "bridge",
      code: "absolute_deadline_exceeded",
    });
    expect(evidence.cleanup).toEqual({
      status: "passed",
      possibleOrphan: false,
    });
    expect(
      harness.requests.some((request) => request.method === "DELETE"),
    ).toBe(true);
    expect(harness.requests.at(-1)?.method).toBe("GET");
  });

  test("fails a dedicated-tier drift but still deletes the exact row", async () => {
    const harness = makeHarness({ create: "wrong-tier", asyncDelete: true });
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence.failure).toEqual({
      phase: "create",
      code: "wrong_execution_tier",
    });
    expect(evidence.path.observedTier).toBe("dedicated-lazy");
    expect(evidence.cleanup.status).toBe("passed");
    const deletion = harness.requests.find(
      (request) => request.method === "DELETE",
    );
    expect(deletion?.body).toMatchObject({
      expectedAgentName: AGENT_NAME,
      expectedExecutionTier: "dedicated-lazy",
    });
  });

  test("recovers an ambiguous committed create only by its exact name", async () => {
    const harness = makeHarness({ create: "throw-after-commit" });
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence.failure).toEqual({
      phase: "create",
      code: "request_failed",
    });
    expect(evidence.capacity.createdAgents).toBe(1);
    expect(evidence.cleanup.status).toBe("passed");
    expect(
      harness.requests.some((request) => request.method === "DELETE"),
    ).toBe(true);
  });

  test("makes ambiguous-create orphan risk the authoritative cleanup failure", async () => {
    const harness = makeHarness({ create: "throw-without-commit" });
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence.failure).toEqual({
      phase: "cleanup",
      code: "possible_orphan_after_ambiguous_create",
    });
    expect(evidence.cleanup).toEqual({
      status: "failed",
      possibleOrphan: true,
    });
  });

  test("cleanup failure overrides an earlier bridge failure", async () => {
    const harness = makeHarness({
      bridgeReply: "invalid",
      cleanupDelete: "fail",
    });
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence.path.bridgeReply).toBe(false);
    expect(evidence.failure).toEqual({
      phase: "cleanup_delete",
      code: "unexpected_http_500",
    });
    expect(evidence.cleanup).toEqual({
      status: "failed",
      possibleOrphan: true,
    });
  });

  test("requires the explicit shared pairing negative", async () => {
    const harness = makeHarness({ pairing: "positive" });
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence.failure).toEqual({
      phase: "pairing",
      code: "unexpected_http_200",
    });
    expect(evidence.path.pairingUnavailable).toBe(false);
    expect(evidence.cleanup.status).toBe("passed");
  });

  test("requires an SSE nonce-bearing reply and a terminal done event", async () => {
    const harness = makeHarness({ sseReply: "invalid" });
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence.failure).toEqual({
      phase: "sse",
      code: "invalid_shared_reply",
    });
    expect(evidence.path.sseCompleted).toBe(false);
    expect(evidence.cleanup.status).toBe("passed");
  });

  test("requires final 404 even after a successful delete response", async () => {
    const harness = makeHarness({ cleanupDelete: "retain" });
    const evidence = await runSharedStagingOnboardingSmoke(harness.options);

    expect(evidence.failure).toEqual({
      phase: "cleanup_confirm",
      code: "final_404_not_observed",
    });
    expect(evidence.cleanup).toEqual({
      status: "failed",
      possibleOrphan: true,
    });
  });

  test("is wired only into the staging Environment of the canonical manual live suite", () => {
    const repositoryRoot = resolve(import.meta.dir, "../../../..");
    const workflow = readFileSync(
      resolve(repositoryRoot, ".github/workflows/live-smoke.yml"),
      "utf8",
    );
    const packageJson = readFileSync(
      resolve(repositoryRoot, "package.json"),
      "utf8",
    );
    const source = readFileSync(
      resolve(import.meta.dir, "live-cloud-provision-smoke.ts"),
      "utf8",
    );

    expect(workflow).toContain("environment: staging");
    expect(workflow).toContain("bun run cloud:shared-onboarding:live");
    expect(workflow).toContain("CLOUD_SHARED_STAGING_SMOKE_EVIDENCE_PATH");
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).toContain("fetch-depth: 0");
    expect(packageJson).toContain('"cloud:shared-onboarding:live"');
    expect(source).not.toContain("CLOUD_SMOKE_KEEP_RESOURCES");
    expect(source).not.toContain("CLOUD_SMOKE_SKIP_STREAM");
    expect(source).not.toContain("createSmokeIdentityViaSiwe");
  });
});
