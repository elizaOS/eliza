import { describe, expect, test } from "bun:test";
import {
  runManagedDedicatedCanary,
  validateManagedDedicatedCanaryEvidence,
} from "./managed-dedicated-canary";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const PROVISION_JOB_ID = "22222222-2222-4222-8222-222222222222";
const DELETE_JOB_ID = "33333333-3333-4333-8333-333333333333";
const SUFFIX = "12345678901234567890";
const SECRET = "cloud_test_secret_never_emit";
const DEPLOYED_COMMIT = "a".repeat(40);
const START_MS = Date.parse("2026-07-13T02:30:00.000Z");

interface FixtureOptions {
  existingCanary?: boolean;
  createdTier?: string;
  readyTier?: string;
  mesh?: boolean;
  bridgeUrl?: string;
  heartbeatAt?: string | null;
  bridgeReply?: "real" | "canned";
  cleanupFails?: boolean;
  postCommitsThenThrows?: boolean;
  recoveryListFailures?: number;
  recoveryNeverFinds?: boolean;
}

function response(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function createFixture(options: FixtureOptions = {}) {
  let nowMs = START_MS;
  let created = false;
  let deleted = false;
  let createBody: Record<string, unknown> | null = null;
  let recoveryListFailures = options.recoveryListFailures ?? 0;
  const calls: Array<{ method: string; pathname: string }> = [];

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    calls.push({ method, pathname: url.pathname });

    if (url.pathname === "/api/health") {
      return response({ status: "ok", commit: DEPLOYED_COMMIT });
    }

    if (url.pathname === "/api/v1/eliza/agents" && method === "GET") {
      if (created && recoveryListFailures > 0) {
        recoveryListFailures -= 1;
        throw new TypeError("transient recovery list failure");
      }
      return response({
        success: true,
        data: options.existingCanary
          ? [
              {
                id: "existing-id",
                agentName: "managed-dedicated-canary-existing",
              },
            ]
          : created && !options.recoveryNeverFinds
            ? [
                {
                  id: AGENT_ID,
                  agentName: String(createBody?.agentName ?? "missing"),
                },
              ]
            : [],
      });
    }

    if (url.pathname === "/api/v1/eliza/agents" && method === "POST") {
      created = true;
      createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (options.postCommitsThenThrows) {
        throw new TypeError("response connection lost after commit");
      }
      return response(
        {
          success: true,
          created: true,
          data: {
            id: AGENT_ID,
            agentId: AGENT_ID,
            agentName: createBody.agentName,
            executionTier: options.createdTier ?? "dedicated-always",
            status: "pending",
            jobId: PROVISION_JOB_ID,
          },
        },
        202,
      );
    }

    if (url.pathname === `/api/v1/jobs/${PROVISION_JOB_ID}`) {
      return response({
        success: true,
        data: { status: "completed", result: { status: "running" } },
      });
    }

    if (url.pathname === `/api/v1/jobs/${DELETE_JOB_ID}`) {
      deleted = true;
      return response({ success: true, data: { status: "completed" } });
    }

    if (
      url.pathname === `/api/v1/eliza/agents/${AGENT_ID}` &&
      method === "GET"
    ) {
      if (deleted) return response({ success: false, error: "not found" }, 404);
      const agentName = String(createBody?.agentName ?? "missing");
      return response({
        success: true,
        data: {
          id: AGENT_ID,
          agentName,
          status: "running",
          databaseStatus: "ready",
          executionTier:
            options.readyTier ?? options.createdTier ?? "dedicated-always",
          lastHeartbeatAt:
            options.heartbeatAt === undefined
              ? new Date(nowMs - 5_000).toISOString()
              : options.heartbeatAt,
          bridgeUrl:
            options.bridgeUrl ??
            (options.mesh === false
              ? "http://192.0.2.10:3000"
              : "http://100.64.0.21:3000"),
          adminDetails: null,
        },
      });
    }

    if (
      url.pathname === `/api/v1/eliza/agents/${AGENT_ID}` &&
      method === "DELETE"
    ) {
      if (options.cleanupFails) {
        return response({ success: false, error: "delete failed" }, 500);
      }
      return response(
        {
          success: true,
          data: { jobId: DELETE_JOB_ID, status: "pending" },
        },
        202,
      );
    }

    if (
      url.pathname === `/api/v1/eliza/agents/${AGENT_ID}/bridge` &&
      method === "POST"
    ) {
      const rpc = JSON.parse(String(init?.body)) as {
        method: string;
        params?: { text?: string };
      };
      if (rpc.method === "status.get") {
        return response({ jsonrpc: "2.0", result: { ready: true } });
      }
      if (rpc.method === "heartbeat") {
        return response({ jsonrpc: "2.0", result: { ok: true } });
      }
      const token =
        rpc.params?.text?.match(/token ([a-z0-9-]+)/)?.[1] ?? "missing";
      return response({
        jsonrpc: "2.0",
        result:
          options.bridgeReply === "canned"
            ? {
                text: "Sorry, I'm having a provider issue",
                failureKind: "provider_issue",
                transport: "conversation-rest",
              }
            : {
                text: `A real reply containing ${token}.`,
                transport: "conversation-rest",
              },
      });
    }

    if (
      url.pathname === `/api/v1/eliza/agents/${AGENT_ID}/stream` &&
      method === "POST"
    ) {
      const rpc = JSON.parse(String(init?.body)) as {
        params?: { text?: string };
      };
      const token =
        rpc.params?.text?.match(/token ([a-z0-9-]+)/)?.[1] ?? "missing";
      const sse =
        `event: chunk\ndata: ${JSON.stringify({ text: `A real stream reply containing ${token}.` })}\n\n` +
        `event: done\ndata: ${JSON.stringify({ ok: true })}\n\n`;
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }

    return response({ error: "unexpected fixture request" }, 599);
  };

  return {
    fetch: fetch as typeof globalThis.fetch,
    now: () => nowMs,
    sleep: async (ms: number) => {
      nowMs += ms;
    },
    calls,
    get createBody() {
      return createBody;
    },
    get created() {
      return created;
    },
  };
}

async function runFixture(options: FixtureOptions = {}) {
  const fixture = createFixture(options);
  const evidence = await runManagedDedicatedCanary({
    apiKey: SECRET,
    suffix: SUFFIX,
    fetch: fixture.fetch,
    now: fixture.now,
    sleep: fixture.sleep,
    pollIntervalMs: 10,
    readyTimeoutMs: 30,
    cleanupTimeoutMs: 30,
    createRecoveryTimeoutMs: 30,
    createRecoveryPollIntervalMs: 10,
  });
  return { fixture, evidence };
}

describe("managed dedicated canary", () => {
  test("proves dedicated readiness, bridge + SSE, then confirms exact cleanup", async () => {
    const { fixture, evidence } = await runFixture();

    expect(evidence.verdict).toBe("pass");
    expect(evidence.deployedCommit).toBe(DEPLOYED_COMMIT);
    expect(evidence.path).toMatchObject({
      requestedTier: "dedicated-always",
      observedTier: "dedicated-always",
      running: true,
      databaseReady: true,
      heartbeatFresh: true,
      meshAddressPresent: true,
      bridgeTransport: "conversation-rest",
      sseCompleted: true,
      successfulPaths: 2,
    });
    expect(evidence.capacity).toMatchObject({
      maxCreatedAgents: 1,
      createdAgents: 1,
      maxChatRequests: 4,
      chatRequests: 2,
    });
    expect(evidence.cleanup.status).toBe("passed");
    expect(evidence.cleanup.possibleOrphan).toBe(false);
    expect(validateManagedDedicatedCanaryEvidence(evidence)).toEqual([]);
    expect(fixture.createBody).toMatchObject({
      alwaysOn: true,
      forceCreate: true,
      autoProvision: true,
    });
    expect(
      fixture.calls.filter(
        (call) =>
          call.method === "POST" && call.pathname === "/api/v1/eliza/agents",
      ),
    ).toHaveLength(1);

    const serialized = JSON.stringify(evidence);
    for (const forbidden of [
      SECRET,
      AGENT_ID,
      PROVISION_JOB_ID,
      DELETE_JOB_ID,
      `managed-dedicated-canary-${SUFFIX}`,
      `bridge-${SUFFIX}`,
      `sse-${SUFFIX}`,
      "100.64.0.21",
      "api-staging.elizacloud.ai",
      "A real reply",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("a missing credential fails before any network or create", async () => {
    const fixture = createFixture();
    const evidence = await runManagedDedicatedCanary({
      apiKey: "  ",
      suffix: SUFFIX,
      fetch: fixture.fetch,
      now: fixture.now,
      sleep: fixture.sleep,
    });
    expect(evidence.verdict).toBe("fail");
    expect(evidence.failure).toEqual({
      phase: "config",
      code: "missing_cloud_credential",
    });
    expect(evidence.cleanup.status).toBe("not-required");
    expect(fixture.calls).toHaveLength(0);
  });

  test("refuses production even when a valid credential is present", async () => {
    const fixture = createFixture();
    const evidence = await runManagedDedicatedCanary({
      apiKey: SECRET,
      baseUrl: "https://api.elizacloud.ai",
      suffix: SUFFIX,
      fetch: fixture.fetch,
      now: fixture.now,
      sleep: fixture.sleep,
    });
    expect(evidence.failure).toEqual({
      phase: "config",
      code: "non_staging_target_refused",
    });
    expect(fixture.calls).toHaveLength(0);
  });

  test("refuses a staging URL carrying userinfo before any network call", async () => {
    const fixture = createFixture();
    const evidence = await runManagedDedicatedCanary({
      apiKey: SECRET,
      baseUrl: "https://user:password@api-staging.elizacloud.ai",
      suffix: SUFFIX,
      fetch: fixture.fetch,
      now: fixture.now,
      sleep: fixture.sleep,
    });
    expect(evidence.failure).toEqual({
      phase: "config",
      code: "non_staging_target_refused",
    });
    expect(fixture.calls).toHaveLength(0);
  });

  test("a prior canary trips the one-agent capacity guard without creating", async () => {
    const { fixture, evidence } = await runFixture({ existingCanary: true });
    expect(evidence.failure).toEqual({
      phase: "capacity_guard",
      code: "existing_canary_present",
    });
    expect(evidence.capacity.createdAgents).toBe(0);
    expect(evidence.cleanup.status).toBe("not-required");
    expect(fixture.created).toBe(false);
  });

  test("a shared-tier response is red and the exact fresh row is still deleted", async () => {
    const { evidence } = await runFixture({
      createdTier: "shared",
      readyTier: "shared",
    });
    expect(evidence.verdict).toBe("fail");
    expect(evidence.failure).toEqual({
      phase: "create",
      code: "wrong_execution_tier",
    });
    expect(evidence.cleanup.status).toBe("passed");
  });

  test("missing mesh evidence and stale heartbeat can never pass readiness", async () => {
    const { evidence } = await runFixture({
      mesh: false,
      heartbeatAt: new Date(START_MS - 130_000).toISOString(),
    });
    expect(evidence.verdict).toBe("fail");
    expect(evidence.failure).toEqual({
      phase: "ready",
      code: "readiness_timeout",
    });
    expect(evidence.path.heartbeatFresh).toBe(false);
    expect(evidence.path.meshAddressPresent).toBe(false);
    expect(evidence.cleanup.status).toBe("passed");
  });

  test("mesh parsing rejects an IPv4 prefix with a non-decimal suffix", async () => {
    const { evidence } = await runFixture({
      bridgeUrl: "http://100.64.0.21evil:3000",
    });
    expect(evidence.verdict).toBe("fail");
    expect(evidence.failure).toEqual({
      phase: "ready",
      code: "readiness_timeout",
    });
    expect(evidence.path.meshAddressPresent).toBe(false);
    expect(evidence.cleanup.status).toBe("passed");
  });

  test("mesh parsing rejects legacy octal IPv4 that URL parsing would normalize", async () => {
    const { evidence } = await runFixture({
      bridgeUrl: "http://100.0100.0.21:3000",
    });
    expect(evidence.failure).toEqual({
      phase: "ready",
      code: "readiness_timeout",
    });
    expect(evidence.path.meshAddressPresent).toBe(false);
    expect(evidence.cleanup.status).toBe("passed");
  });

  test("a committed create whose response times out is recovered and deleted", async () => {
    const { fixture, evidence } = await runFixture({
      postCommitsThenThrows: true,
    });
    expect(evidence.verdict).toBe("fail");
    expect(evidence.failure).toEqual({
      phase: "create",
      code: "request_failed",
    });
    expect(evidence.capacity.createdAgents).toBe(1);
    expect(evidence.cleanup).toEqual({
      status: "passed",
      possibleOrphan: false,
    });
    expect(
      fixture.calls.filter((call) => call.method === "DELETE"),
    ).toHaveLength(1);
  });

  test("ambiguous-create recovery survives a transient list failure", async () => {
    const { fixture, evidence } = await runFixture({
      postCommitsThenThrows: true,
      recoveryListFailures: 1,
    });
    expect(evidence.failure).toEqual({
      phase: "create",
      code: "request_failed",
    });
    expect(evidence.cleanup).toEqual({
      status: "passed",
      possibleOrphan: false,
    });
    expect(
      fixture.calls.filter(
        (call) =>
          call.method === "GET" && call.pathname === "/api/v1/eliza/agents",
      ),
    ).toHaveLength(3);
  });

  test("unresolved ambiguous create reports cleanup failure and possible orphan", async () => {
    const { evidence } = await runFixture({
      postCommitsThenThrows: true,
      recoveryNeverFinds: true,
    });
    expect(evidence.verdict).toBe("fail");
    expect(evidence.failure).toEqual({
      phase: "cleanup",
      code: "possible_orphan_after_ambiguous_create",
    });
    expect(evidence.cleanup).toEqual({
      status: "failed",
      possibleOrphan: true,
    });
  });

  test("canned bridge replies exhaust only the bounded attempts and fail", async () => {
    const { evidence } = await runFixture({ bridgeReply: "canned" });
    expect(evidence.verdict).toBe("fail");
    expect(evidence.failure).toEqual({
      phase: "bridge_turn",
      code: "invalid_reply",
    });
    expect(evidence.capacity.chatRequests).toBe(2);
    expect(evidence.capacity.chatRequests).toBeLessThanOrEqual(
      evidence.capacity.maxChatRequests,
    );
    expect(evidence.cleanup.status).toBe("passed");
  });

  test("cleanup failure overrides a successful path and stays red", async () => {
    const { evidence } = await runFixture({ cleanupFails: true });
    expect(evidence.path.successfulPaths).toBe(2);
    expect(evidence.cleanup.status).toBe("failed");
    expect(evidence.cleanup.possibleOrphan).toBe(true);
    expect(evidence.failure).toEqual({
      phase: "cleanup_delete",
      code: "unexpected_http_500",
    });
    expect(evidence.verdict).toBe("fail");
  });

  test("the workflow validator rejects skip-like and zero-executed evidence", () => {
    expect(validateManagedDedicatedCanaryEvidence({})).toContain(
      "successful_paths_not_two",
    );
    expect(
      validateManagedDedicatedCanaryEvidence({
        schemaVersion: 1,
        verdict: "pass",
        deployedCommit: DEPLOYED_COMMIT,
        path: {
          requestedTier: "dedicated-always",
          observedTier: "dedicated-always",
          running: true,
          databaseReady: true,
          heartbeatFresh: true,
          meshAddressPresent: true,
          bridgeTransport: "conversation-rest",
          sseCompleted: true,
          successfulPaths: 0,
        },
        capacity: {
          maxCreatedAgents: 1,
          createdAgents: 1,
          maxChatRequests: 4,
          chatRequests: 0,
        },
        cleanup: { status: "passed" },
        failure: null,
      }),
    ).toEqual(
      expect.arrayContaining([
        "successful_paths_not_two",
        "chat_request_count_invalid",
      ]),
    );
  });

  test("the workflow validator requires every success timing to be finite and nonnegative", async () => {
    const { evidence } = await runFixture();
    const missing = structuredClone(evidence);
    delete missing.timingsMs.bridge;
    expect(validateManagedDedicatedCanaryEvidence(missing)).toContain(
      "invalid_timing_bridge",
    );

    const negative = structuredClone(evidence);
    negative.timingsMs.health = -1;
    expect(validateManagedDedicatedCanaryEvidence(negative)).toContain(
      "invalid_timing_health",
    );

    const infinite = structuredClone(evidence);
    infinite.timingsMs.total = Number.POSITIVE_INFINITY;
    expect(validateManagedDedicatedCanaryEvidence(infinite)).toContain(
      "invalid_timing_total",
    );
  });
});
