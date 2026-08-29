/**
 * Exercises the staging canary's fail-closed identity, capacity, live-path,
 * privacy, and exact-cleanup contracts through a deterministic HTTP fixture.
 */
import { describe, expect, test } from "bun:test";
import type { ManagedDedicatedCanaryEvidence } from "./managed-dedicated-canary";
import {
  canonicalizeManagedDedicatedCanaryArtifact,
  runManagedDedicatedCanary,
  validateManagedDedicatedCanaryArtifact,
  validateManagedDedicatedCanaryCleanupEvidence,
  validateManagedDedicatedCanaryEvidence,
} from "./managed-dedicated-canary";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const PROVISION_JOB_ID = "22222222-2222-4222-8222-222222222222";
const DELETE_JOB_ID = "33333333-3333-4333-8333-333333333333";
const STALE_AGENT_ID = "44444444-4444-4444-8444-444444444444";
const STALE_DELETE_JOB_ID = "55555555-5555-4555-8555-555555555555";
const SUFFIX = "12345678901234567890";
const STALE_SUFFIX = "r30081355987a1";
const SECRET = "cloud_test_secret_never_emit";
const DEPLOYED_COMMIT = "a".repeat(40);
const START_MS = Date.parse("2026-07-13T02:30:00.000Z");

interface FixtureOptions {
  healthCommit?: string | null;
  existingCanary?: boolean;
  existingCanaryCount?: number;
  existingCanarySuffix?: string;
  staleCleanupFails?: boolean;
  staleDeleteThrows?: boolean;
  staleIdentityMismatch?: boolean;
  staleTier?: string;
  createStatus?: number;
  createdTier?: string;
  readyTier?: string;
  mesh?: boolean;
  bridgeUrl?: string;
  heartbeatAt?: string | null;
  bridgeReply?: "real" | "canned";
  cleanupFails?: boolean;
  postCommitsThenThrows?: boolean;
  provisionNeverCompletes?: boolean;
  provisionFailsWithError?: string;
  provisionCompletesAfterPolls?: number;
  recoveryListFailures?: number;
  recoveryNeverFinds?: boolean;
  bridgeStatusError?: unknown;
  sseMissingDone?: boolean;
  requestLatencyMs?: number;
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
  let staleDeleted = false;
  let createBody: Record<string, unknown> | null = null;
  let staleDeleteBody: Record<string, unknown> | null = null;
  let freshDeleteBody: Record<string, unknown> | null = null;
  let provisionPolls = 0;
  let provisionCompleted = false;
  let recoveryListFailures = options.recoveryListFailures ?? 0;
  const calls: Array<{ method: string; pathname: string }> = [];

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    nowMs += options.requestLatencyMs ?? 0;
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    calls.push({ method, pathname: url.pathname });

    if (url.pathname === "/api/health") {
      return response({
        status: "ok",
        commit:
          options.healthCommit === undefined
            ? DEPLOYED_COMMIT
            : options.healthCommit,
      });
    }

    if (url.pathname === "/api/v1/eliza/agents" && method === "GET") {
      if (created && recoveryListFailures > 0) {
        recoveryListFailures -= 1;
        throw new TypeError("transient recovery list failure");
      }
      return response({
        success: true,
        data:
          !staleDeleted &&
          (options.existingCanaryCount ?? (options.existingCanary ? 1 : 0)) > 0
            ? Array.from(
                {
                  length:
                    options.existingCanaryCount ??
                    (options.existingCanary ? 1 : 0),
                },
                (_, index) => ({
                  id: index === 0 ? STALE_AGENT_ID : `stale-agent-${index + 1}`,
                  agentName: `managed-dedicated-canary-${
                    options.existingCanarySuffix ?? "existing"
                  }`,
                }),
              )
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
      if (options.createStatus) {
        return response(
          { success: false, error: "redacted" },
          options.createStatus,
        );
      }
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
      provisionPolls += 1;
      if (options.provisionFailsWithError) {
        return response({
          success: true,
          data: { status: "failed", error: options.provisionFailsWithError },
        });
      }
      if (
        options.provisionNeverCompletes ||
        (options.provisionCompletesAfterPolls !== undefined &&
          provisionPolls < options.provisionCompletesAfterPolls)
      ) {
        return response({
          success: true,
          data: { status: "in_progress" },
        });
      }
      provisionCompleted = true;
      return response({
        success: true,
        data: { status: "completed", result: { status: "running" } },
      });
    }

    if (url.pathname === `/api/v1/jobs/${DELETE_JOB_ID}`) {
      deleted = true;
      return response({ success: true, data: { status: "completed" } });
    }

    if (url.pathname === `/api/v1/jobs/${STALE_DELETE_JOB_ID}`) {
      staleDeleted = true;
      return response({ success: true, data: { status: "completed" } });
    }

    if (
      url.pathname === `/api/v1/eliza/agents/${STALE_AGENT_ID}` &&
      method === "GET"
    ) {
      if (staleDeleted) {
        return response({ success: false, error: "not found" }, 404);
      }
      return response({
        success: true,
        data: {
          id: options.staleIdentityMismatch ? AGENT_ID : STALE_AGENT_ID,
          agentName: `managed-dedicated-canary-${
            options.existingCanarySuffix ?? "existing"
          }`,
          executionTier: options.staleTier ?? "dedicated-always",
          createdAt: "2026-07-13T08:17:00.000Z",
          status: "error",
        },
      });
    }

    if (
      url.pathname === `/api/v1/eliza/agents/${STALE_AGENT_ID}` &&
      method === "DELETE"
    ) {
      staleDeleteBody = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      if (options.staleDeleteThrows) {
        throw new Error("simulated transport ambiguity");
      }
      if (options.staleCleanupFails) {
        return response(
          { success: false, error: "provisioning is in progress" },
          409,
        );
      }
      return response(
        {
          success: true,
          data: { jobId: STALE_DELETE_JOB_ID, status: "pending" },
        },
        202,
      );
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
          status: provisionCompleted ? "running" : "provisioning",
          databaseStatus: "ready",
          executionTier:
            options.readyTier ?? options.createdTier ?? "dedicated-always",
          createdAt: "2026-07-13T02:30:00.000Z",
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
      freshDeleteBody = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
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
        if (options.bridgeStatusError !== undefined) {
          return response({
            jsonrpc: "2.0",
            id: `status.get-${SUFFIX}`,
            error: options.bridgeStatusError,
          });
        }
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
        (options.sseMissingDone
          ? ""
          : `event: done\ndata: ${JSON.stringify({ ok: true })}\n\n`);
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
    get staleDeleteBody() {
      return staleDeleteBody;
    },
    get freshDeleteBody() {
      return freshDeleteBody;
    },
    get created() {
      return created;
    },
  };
}

async function runFixture(
  options: FixtureOptions = {},
  canaryOptions: {
    staleCanarySuffix?: string;
    cleanupOnly?: boolean;
    expectedDeployCommit?: string;
  } = {},
) {
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
    expectedDeployCommit: canaryOptions.cleanupOnly
      ? DEPLOYED_COMMIT
      : undefined,
    ...canaryOptions,
  });
  return { fixture, evidence };
}

describe("managed dedicated canary", () => {
  test("proves dedicated readiness, bridge + SSE, then confirms exact cleanup", async () => {
    const { fixture, evidence } = await runFixture();

    expect(evidence.verdict).toBe("pass");
    expect(evidence.operation).toBe("canary");
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
    expect(evidence.recovery).toEqual({
      requested: false,
      match: "none",
      performed: "not-attempted",
      confirmed: false,
    });
    expect(evidence.cleanup.status).toBe("passed");
    expect(evidence.cleanup.possibleOrphan).toBe(false);
    expect(validateManagedDedicatedCanaryArtifact(evidence)).toEqual([]);
    expect(validateManagedDedicatedCanaryEvidence(evidence)).toEqual([]);
    expect(fixture.createBody).toMatchObject({
      alwaysOn: true,
      forceCreate: true,
      autoProvision: true,
    });
    expect(fixture.freshDeleteBody).toEqual({
      expectedAgentName: `managed-dedicated-canary-${SUFFIX}`,
      expectedCreatedAt: "2026-07-13T02:30:00.000Z",
      expectedExecutionTier: "dedicated-always",
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
      "api-staging.eliza.app",
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
    expect(evidence.timingsMs).toMatchObject({ cleanup: 0, total: 0 });
    expect(validateManagedDedicatedCanaryArtifact(evidence)).toEqual([]);
    expect(fixture.calls).toHaveLength(0);
  });

  test("an invalid run suffix still returns strict red evidence without network access", async () => {
    const fixture = createFixture();
    const evidence = await runManagedDedicatedCanary({
      apiKey: SECRET,
      suffix: "bad key",
      fetch: fixture.fetch,
      now: fixture.now,
      sleep: fixture.sleep,
    });

    expect(evidence.verdict).toBe("fail");
    expect(evidence.failure).toEqual({
      phase: "config",
      code: "invalid_run_suffix",
    });
    expect(evidence.cleanup).toEqual({
      status: "not-required",
      possibleOrphan: false,
    });
    expect(evidence.timingsMs).toMatchObject({ cleanup: 0, total: 0 });
    expect(validateManagedDedicatedCanaryArtifact(evidence)).toEqual([]);
    expect(JSON.stringify(evidence)).not.toContain("bad key");
    expect(fixture.calls).toHaveLength(0);
  });

  test("an invalid stale-canary suffix fails before any network access", async () => {
    const fixture = createFixture();
    const evidence = await runManagedDedicatedCanary({
      apiKey: SECRET,
      suffix: SUFFIX,
      staleCanarySuffix: "managed-dedicated-canary-delete-anything",
      fetch: fixture.fetch,
      now: fixture.now,
      sleep: fixture.sleep,
    });

    expect(evidence.failure).toEqual({
      phase: "config",
      code: "invalid_stale_canary_suffix",
    });
    expect(validateManagedDedicatedCanaryArtifact(evidence)).toEqual([]);
    expect(fixture.calls).toHaveLength(0);
  });

  test("cleanup-only requires an exact stale-canary suffix before network access", async () => {
    const { fixture, evidence } = await runFixture({}, { cleanupOnly: true });
    expect(evidence.operation).toBe("cleanup-only");
    expect(evidence.failure).toEqual({
      phase: "config",
      code: "invalid_stale_canary_suffix",
    });
    expect(evidence.verdict).toBe("fail");
    expect(fixture.calls).toHaveLength(0);
  });

  test("cleanup-only requires a preflight-bound deploy commit before network access", async () => {
    const { fixture, evidence } = await runFixture(
      {},
      {
        staleCanarySuffix: STALE_SUFFIX,
        cleanupOnly: true,
        expectedDeployCommit: "",
      },
    );
    expect(evidence.failure).toEqual({
      phase: "config",
      code: "invalid_expected_deploy_commit",
    });
    expect(fixture.calls).toHaveLength(0);
  });

  test("cleanup-only cancels before listing or deleting when staging changed after preflight", async () => {
    const { fixture, evidence } = await runFixture(
      { existingCanary: true, existingCanarySuffix: STALE_SUFFIX },
      {
        staleCanarySuffix: STALE_SUFFIX,
        cleanupOnly: true,
        expectedDeployCommit: "f".repeat(40),
      },
    );
    expect(evidence.failure).toEqual({
      phase: "health",
      code: "deployed_commit_changed",
    });
    expect(fixture.calls).toEqual([{ method: "GET", pathname: "/api/health" }]);
  });

  test("refuses production even when a valid credential is present", async () => {
    const fixture = createFixture();
    const evidence = await runManagedDedicatedCanary({
      apiKey: SECRET,
      baseUrl: "https://api.eliza.app",
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
      baseUrl: "https://user:password@api-staging.eliza.app",
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

  test("records health phase duration when deploy evidence fails", async () => {
    const { evidence } = await runFixture({
      healthCommit: null,
      requestLatencyMs: 7,
    });
    expect(evidence.failure).toEqual({
      phase: "health",
      code: "missing_deploy_commit",
    });
    expect(evidence.timingsMs.health).toBe(7);
    expect(validateManagedDedicatedCanaryArtifact(evidence)).toEqual([]);
  });

  test("a prior canary trips the one-agent capacity guard without creating", async () => {
    const { fixture, evidence } = await runFixture({
      existingCanary: true,
      requestLatencyMs: 7,
    });
    expect(evidence.failure).toEqual({
      phase: "capacity_guard",
      code: "existing_canary_present",
    });
    expect(evidence.capacity.createdAgents).toBe(0);
    expect(evidence.cleanup.status).toBe("not-required");
    expect(evidence.timingsMs.capacityGuard).toBe(7);
    expect(validateManagedDedicatedCanaryArtifact(evidence)).toEqual([]);
    expect(fixture.created).toBe(false);
  });

  test("an explicit exact suffix deletes one verified stale canary before the fresh proof", async () => {
    const { fixture, evidence } = await runFixture(
      {
        existingCanary: true,
        existingCanarySuffix: STALE_SUFFIX,
      },
      { staleCanarySuffix: STALE_SUFFIX },
    );

    expect(evidence.verdict).toBe("pass");
    expect(evidence.operation).toBe("canary");
    expect(evidence.failure).toBeNull();
    expect(evidence.capacity.createdAgents).toBe(1);
    expect(evidence.recovery).toEqual({
      requested: true,
      match: "one",
      performed: "accepted",
      confirmed: true,
    });
    expect(evidence.cleanup).toEqual({
      status: "passed",
      possibleOrphan: false,
    });
    expect(validateManagedDedicatedCanaryArtifact(evidence)).toEqual([]);
    expect(validateManagedDedicatedCanaryEvidence(evidence)).toEqual([]);
    expect(fixture.staleDeleteBody).toEqual({
      expectedAgentName: `managed-dedicated-canary-${STALE_SUFFIX}`,
      expectedCreatedAt: "2026-07-13T08:17:00.000Z",
      expectedExecutionTier: "dedicated-always",
    });
    expect(fixture.calls.filter((call) => call.method === "DELETE")).toEqual([
      {
        method: "DELETE",
        pathname: `/api/v1/eliza/agents/${STALE_AGENT_ID}`,
      },
      {
        method: "DELETE",
        pathname: `/api/v1/eliza/agents/${AGENT_ID}`,
      },
    ]);
  });

  test("cleanup-only deletes exactly one verified stale canary without creating a replacement", async () => {
    const { fixture, evidence } = await runFixture(
      {
        existingCanary: true,
        existingCanarySuffix: STALE_SUFFIX,
      },
      { staleCanarySuffix: STALE_SUFFIX, cleanupOnly: true },
    );

    expect(evidence.verdict).toBe("pass");
    expect(evidence.operation).toBe("cleanup-only");
    expect(evidence.failure).toBeNull();
    expect(evidence.capacity.createdAgents).toBe(0);
    expect(evidence.capacity.chatRequests).toBe(0);
    expect(evidence.path.successfulPaths).toBe(0);
    expect(evidence.recovery).toEqual({
      requested: true,
      match: "one",
      performed: "accepted",
      confirmed: true,
    });
    expect(evidence.cleanup).toEqual({
      status: "passed",
      possibleOrphan: false,
    });
    expect(validateManagedDedicatedCanaryArtifact(evidence)).toEqual([]);
    expect(validateManagedDedicatedCanaryCleanupEvidence(evidence)).toEqual([]);
    expect(validateManagedDedicatedCanaryEvidence(evidence)).toContain(
      "wrong_operation",
    );
    expect(fixture.staleDeleteBody).toEqual({
      expectedAgentName: `managed-dedicated-canary-${STALE_SUFFIX}`,
      expectedCreatedAt: "2026-07-13T08:17:00.000Z",
      expectedExecutionTier: "dedicated-always",
      expectedDeployCommit: DEPLOYED_COMMIT,
    });
    expect(fixture.calls.filter((call) => call.method === "DELETE")).toEqual([
      {
        method: "DELETE",
        pathname: `/api/v1/eliza/agents/${STALE_AGENT_ID}`,
      },
    ]);
    expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(
      0,
    );
  });

  test("cleanup-only deletion fails closed against the legacy strict request schema", async () => {
    const { fixture } = await runFixture(
      {
        existingCanary: true,
        existingCanarySuffix: STALE_SUFFIX,
      },
      { staleCanarySuffix: STALE_SUFFIX, cleanupOnly: true },
    );
    const legacyStrictKeys = new Set([
      "expectedAgentName",
      "expectedCreatedAt",
      "expectedExecutionTier",
    ]);
    const legacyUnknownKeys = Object.keys(fixture.staleDeleteBody ?? {}).filter(
      (key) => !legacyStrictKeys.has(key),
    );

    // The precondition deliberately rides in the strict JSON body: an older
    // route rejects this unknown key before reaching its deletion service.
    expect(legacyUnknownKeys).toEqual(["expectedDeployCommit"]);
  });

  test("cleanup-only validation rejects full-canary work and contradictory evidence", async () => {
    const { evidence } = await runFixture(
      {
        existingCanary: true,
        existingCanarySuffix: STALE_SUFFIX,
      },
      { staleCanarySuffix: STALE_SUFFIX, cleanupOnly: true },
    );
    const created = structuredClone(evidence);
    created.capacity.createdAgents = 1;
    const pathExecuted = structuredClone(evidence);
    pathExecuted.path.successfulPaths = 1;
    const timedCreate = structuredClone(evidence);
    timedCreate.timingsMs.create = 0;
    const wrongMode = structuredClone(evidence);
    wrongMode.operation = "canary";

    expect(validateManagedDedicatedCanaryCleanupEvidence(created)).toContain(
      "cleanup_created_agent",
    );
    expect(
      validateManagedDedicatedCanaryCleanupEvidence(pathExecuted),
    ).toContain("cleanup_live_path_executed");
    expect(
      validateManagedDedicatedCanaryCleanupEvidence(timedCreate),
    ).toContain("unexpected_timing_create");
    expect(validateManagedDedicatedCanaryCleanupEvidence(wrongMode)).toContain(
      "wrong_operation",
    );
  });

  test("an explicit recovery suffix fails when its stale canary is absent", async () => {
    const { fixture, evidence } = await runFixture(
      {},
      { staleCanarySuffix: STALE_SUFFIX },
    );

    expect(evidence.failure).toEqual({
      phase: "capacity_guard",
      code: "expected_stale_canary_missing",
    });
    expect(evidence.recovery).toEqual({
      requested: true,
      match: "none",
      performed: "not-attempted",
      confirmed: false,
    });
    expect(fixture.created).toBe(false);
  });

  test("stale recovery refuses a different valid canary identity without deleting", async () => {
    const { fixture, evidence } = await runFixture(
      {
        existingCanary: true,
        existingCanarySuffix: STALE_SUFFIX,
      },
      { staleCanarySuffix: "r30081355988a1" },
    );

    expect(evidence.failure).toEqual({
      phase: "capacity_guard",
      code: "identity_mismatch",
    });
    expect(fixture.created).toBe(false);
    expect(
      fixture.calls.filter((call) => call.method === "DELETE"),
    ).toHaveLength(0);
  });

  test("stale recovery refuses a non-dedicated target without deleting", async () => {
    const { fixture, evidence } = await runFixture(
      {
        existingCanary: true,
        existingCanarySuffix: STALE_SUFFIX,
        staleTier: "shared",
      },
      { staleCanarySuffix: STALE_SUFFIX },
    );

    expect(evidence.failure).toEqual({
      phase: "capacity_guard",
      code: "identity_mismatch",
    });
    expect(fixture.created).toBe(false);
    expect(
      fixture.calls.filter((call) => call.method === "DELETE"),
    ).toHaveLength(0);
  });

  test("stale recovery fails closed when more than one canary exists", async () => {
    const { fixture, evidence } = await runFixture(
      {
        existingCanaryCount: 2,
        existingCanarySuffix: STALE_SUFFIX,
      },
      { staleCanarySuffix: STALE_SUFFIX },
    );

    expect(evidence.failure).toEqual({
      phase: "capacity_guard",
      code: "existing_canary_present",
    });
    expect(fixture.created).toBe(false);
    expect(
      fixture.calls.filter((call) => call.method === "DELETE"),
    ).toHaveLength(0);
  });

  test("stale recovery reports a normal API conflict and never creates a second canary", async () => {
    const { fixture, evidence } = await runFixture(
      {
        existingCanary: true,
        existingCanarySuffix: STALE_SUFFIX,
        staleCleanupFails: true,
      },
      { staleCanarySuffix: STALE_SUFFIX },
    );

    expect(evidence.failure).toEqual({
      phase: "capacity_guard",
      code: "unexpected_http_409",
    });
    expect(fixture.created).toBe(false);
    expect(
      fixture.calls.filter(
        (call) =>
          call.method === "DELETE" &&
          call.pathname === `/api/v1/eliza/agents/${STALE_AGENT_ID}`,
      ),
    ).toHaveLength(1);
  });

  test("stale recovery records an ambiguous delete transport and never creates a second canary", async () => {
    const { fixture, evidence } = await runFixture(
      {
        existingCanary: true,
        existingCanarySuffix: STALE_SUFFIX,
        staleDeleteThrows: true,
      },
      { staleCanarySuffix: STALE_SUFFIX },
    );

    expect(evidence.failure).toEqual({
      phase: "capacity_guard",
      code: "request_failed",
    });
    expect(evidence.recovery).toEqual({
      requested: true,
      match: "one",
      performed: "ambiguous",
      confirmed: false,
    });
    expect(fixture.created).toBe(false);
    expect(validateManagedDedicatedCanaryArtifact(evidence)).toEqual([]);
  });

  test("a shared-tier response is red and the exact fresh row is still deleted", async () => {
    const { evidence } = await runFixture({
      createdTier: "shared",
      readyTier: "shared",
      requestLatencyMs: 7,
    });
    expect(evidence.verdict).toBe("fail");
    expect(evidence.failure).toEqual({
      phase: "create",
      code: "wrong_execution_tier",
    });
    expect(evidence.cleanup.status).toBe("passed");
    expect(evidence.timingsMs.create).toBe(7);
    expect(validateManagedDedicatedCanaryArtifact(evidence)).toEqual([]);
  });

  test("classifies an unfunded Dedicated admission before any agent can exist", async () => {
    const { fixture, evidence } = await runFixture({ createStatus: 402 });

    expect(evidence.failure).toEqual({
      phase: "create",
      code: "insufficient_hosting_credit",
    });
    expect(evidence.capacity.createdAgents).toBe(0);
    expect(evidence.cleanup).toEqual({
      status: "not-required",
      possibleOrphan: false,
    });
    expect(fixture.created).toBe(false);
    expect(
      fixture.calls.filter((call) => call.method === "DELETE"),
    ).toHaveLength(0);
  });

  test("red evidence classifies an unknown upstream tier without retaining it", async () => {
    const unsafeTier = "private-tier-secret-value";
    const { evidence, fixture } = await runFixture({
      createdTier: unsafeTier,
    });
    expect(evidence.failure).toEqual({
      phase: "create",
      code: "wrong_execution_tier",
    });
    expect(evidence.path.observedTier).toBe("other");
    expect(evidence.cleanup).toEqual({
      status: "failed",
      possibleOrphan: true,
    });
    expect(
      fixture.calls.filter((call) => call.method === "DELETE"),
    ).toHaveLength(0);
    expect(JSON.stringify(evidence)).not.toContain(unsafeTier);
    expect(validateManagedDedicatedCanaryArtifact(evidence)).toEqual([]);
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
    expect(evidence.timingsMs.ready).toBe(30);
    expect(evidence.cleanup.status).toBe("passed");
    expect(validateManagedDedicatedCanaryArtifact(evidence)).toEqual([]);
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

  test("cleanup refuses to delete while the known provision job is still running", async () => {
    const { fixture, evidence } = await runFixture({
      provisionNeverCompletes: true,
    });

    expect(evidence.failure).toEqual({
      phase: "provision",
      code: "job_timeout",
    });
    expect(evidence.cleanup).toEqual({
      status: "failed",
      possibleOrphan: true,
    });
    expect(
      fixture.calls.filter(
        (call) =>
          call.method === "DELETE" &&
          call.pathname === `/api/v1/eliza/agents/${AGENT_ID}`,
      ),
    ).toHaveLength(0);
    expect(fixture.freshDeleteBody).toBeNull();
  });

  test("preserves a privacy-safe provisioning category when cleanup sees the same failed job", async () => {
    const { evidence } = await runFixture({
      provisionFailsWithError:
        "Docker image pull failed before container create",
    });

    expect(evidence.failure).toEqual({
      phase: "provision",
      code: "provisioning_image_failed",
    });
    expect(evidence.cleanup).toEqual({
      status: "failed",
      possibleOrphan: true,
    });
    expect(validateManagedDedicatedCanaryArtifact(evidence)).toEqual([]);
    expect(JSON.stringify(evidence)).not.toContain("Docker image pull failed");
  });

  test("cleanup waits for the known provision job to quiesce before deleting", async () => {
    const { fixture, evidence } = await runFixture({
      provisionCompletesAfterPolls: 4,
    });

    expect(evidence.failure).toEqual({
      phase: "provision",
      code: "job_timeout",
    });
    expect(evidence.cleanup).toEqual({
      status: "passed",
      possibleOrphan: false,
    });
    expect(
      fixture.calls.filter(
        (call) =>
          call.method === "GET" &&
          call.pathname === `/api/v1/jobs/${PROVISION_JOB_ID}`,
      ),
    ).toHaveLength(4);
    expect(
      fixture.calls.filter(
        (call) =>
          call.method === "DELETE" &&
          call.pathname === `/api/v1/eliza/agents/${AGENT_ID}`,
      ),
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
      phase: "create",
      code: "request_failed",
    });
    expect(evidence.cleanup).toEqual({
      status: "failed",
      possibleOrphan: true,
    });
    expect(validateManagedDedicatedCanaryArtifact(evidence)).toEqual([]);
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

  test("classifies the public bridge-unreachable RPC error without retaining its message", async () => {
    const { evidence } = await runFixture({
      bridgeStatusError: {
        code: -32000,
        message: "Sandbox bridge is unreachable",
      },
      requestLatencyMs: 7,
    });
    expect(evidence.failure).toEqual({
      phase: "bridge_status",
      code: "rpc_bridge_unreachable",
    });
    expect(evidence.capacity.chatRequests).toBe(0);
    expect(evidence.cleanup.status).toBe("passed");
    expect(evidence.timingsMs.bridge).toBe(7);
    expect(JSON.stringify(evidence)).not.toContain(
      "Sandbox bridge is unreachable",
    );
  });

  test("never copies an unrecognized RPC error message into evidence", async () => {
    const sensitiveDetail =
      "provider secret and private runtime hostname must never be retained";
    const { evidence } = await runFixture({
      bridgeStatusError: {
        code: -32123,
        message: sensitiveDetail,
      },
    });
    expect(evidence.failure).toEqual({
      phase: "bridge_status",
      code: "rpc_error_code_-32123",
    });
    expect(JSON.stringify(evidence)).not.toContain(sensitiveDetail);
    expect(evidence.cleanup.status).toBe("passed");
  });

  test("classifies every allowlisted public RPC error without retaining raw messages", async () => {
    const cases: Array<{ error: unknown; expected: string }> = [
      { error: "malformed", expected: "rpc_error_invalid_shape" },
      {
        error: { code: -32000, message: "Sandbox is not running" },
        expected: "rpc_sandbox_not_running",
      },
      {
        error: {
          code: -32601,
          message: "Method not found: private-provider-detail",
        },
        expected: "rpc_method_not_found",
      },
      {
        error: { code: -32000, message: "Bridge returned HTTP 503" },
        expected: "rpc_upstream_http_503",
      },
      {
        error: { code: "not-numeric", message: "private runtime detail" },
        expected: "rpc_error_unclassified",
      },
    ];

    for (const fixtureCase of cases) {
      const { evidence } = await runFixture({
        bridgeStatusError: fixtureCase.error,
      });
      expect(evidence.failure).toEqual({
        phase: "bridge_status",
        code: fixtureCase.expected,
      });
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toContain("private-provider-detail");
      expect(serialized).not.toContain("private runtime detail");
      expect(validateManagedDedicatedCanaryArtifact(evidence)).toEqual([]);
    }
  });

  test("records SSE phase duration when an incomplete stream fails", async () => {
    const { evidence } = await runFixture({
      sseMissingDone: true,
      requestLatencyMs: 7,
    });
    expect(evidence.failure).toEqual({
      phase: "sse",
      code: "missing_done_event",
    });
    expect(evidence.timingsMs.sse).toBe(14);
    expect(evidence.cleanup.status).toBe("passed");
    expect(validateManagedDedicatedCanaryArtifact(evidence)).toEqual([]);
  });

  test("strict artifact validation accepts sanitized red evidence", async () => {
    const { evidence } = await runFixture({
      bridgeStatusError: {
        code: -32000,
        message: "Sandbox bridge is unreachable",
      },
    });
    expect(evidence.verdict).toBe("fail");
    expect(validateManagedDedicatedCanaryArtifact(evidence)).toEqual([]);
  });

  test("strict artifact validation rejects unknown fields recursively without echoing them", async () => {
    const { evidence } = await runFixture({
      bridgeStatusError: {
        code: -32000,
        message: "Sandbox bridge is unreachable",
      },
    });
    const topLevel = {
      ...structuredClone(evidence),
      rawReplyContainingSecret: "cloud-secret-must-not-appear",
    };
    const nested = structuredClone(
      evidence,
    ) as ManagedDedicatedCanaryEvidence & {
      path: ManagedDedicatedCanaryEvidence["path"] & { rawReply?: string };
    };
    nested.path.rawReply = "private model output";

    const topErrors = validateManagedDedicatedCanaryArtifact(topLevel);
    const nestedErrors = validateManagedDedicatedCanaryArtifact(nested);
    expect(topErrors).toContain("evidence_unexpected_field");
    expect(nestedErrors).toContain("path_unexpected_field");
    expect(JSON.stringify(topErrors)).not.toContain("rawReplyContainingSecret");
    expect(JSON.stringify(nestedErrors)).not.toContain("private model output");
  });

  test("canonical artifact bytes remove secret-bearing duplicate JSON keys", async () => {
    const { evidence } = await runFixture();
    const secret = "secret-in-shadowed-duplicate-field";
    const raw = JSON.stringify(evidence).replace(
      '"failure":null',
      `"failure":{"phase":"internal","code":"${secret}"},"failure":null`,
    );

    expect(raw).toContain(secret);
    const result = canonicalizeManagedDedicatedCanaryArtifact(raw);
    expect(result.errors).toEqual([]);
    expect(result.canonical).not.toBeNull();
    expect(result.canonical).not.toContain(secret);
    expect(JSON.parse(result.canonical ?? "")).toEqual(evidence);
  });

  test("strict artifact validation rejects secret-like strings in allowed fields", async () => {
    const { evidence } = await runFixture({
      bridgeStatusError: {
        code: -32000,
        message: "Sandbox bridge is unreachable",
      },
    });
    const unsafeFailure = structuredClone(evidence);
    if (!unsafeFailure.failure) throw new Error("fixture must fail");
    unsafeFailure.failure.code = "raw-provider-secret-value";
    const unsafeTier = structuredClone(evidence) as unknown as {
      path: Record<string, unknown>;
    };
    unsafeTier.path.observedTier = "raw-reply-and-secret-like-value";

    expect(validateManagedDedicatedCanaryArtifact(unsafeFailure)).toContain(
      "unsafe_failure_code",
    );
    expect(validateManagedDedicatedCanaryArtifact(unsafeTier)).toContain(
      "unsafe_observed_tier",
    );
  });

  test("strict artifact validation rejects unsafe nested types and timing values", async () => {
    const { evidence } = await runFixture();
    const unsafe = structuredClone(evidence) as unknown as {
      path: Record<string, unknown>;
      timingsMs: Record<string, unknown>;
    };
    unsafe.path.running = "true";
    unsafe.timingsMs.total = Number.NaN;

    const errors = validateManagedDedicatedCanaryArtifact(unsafe);
    expect(errors).toContain("unsafe_path_running");
    expect(errors).toContain("unsafe_timing_value");
  });

  test("strict artifact validation rejects contradictory recovery claims", async () => {
    const { evidence } = await runFixture();
    const mutationWithoutRequest = structuredClone(evidence);
    mutationWithoutRequest.recovery = {
      requested: false,
      match: "none",
      performed: "accepted",
      confirmed: true,
    };
    const confirmationWithoutAcceptance = structuredClone(evidence);
    confirmationWithoutAcceptance.recovery = {
      requested: true,
      match: "one",
      performed: "ambiguous",
      confirmed: true,
    };

    expect(
      validateManagedDedicatedCanaryArtifact(mutationWithoutRequest),
    ).toEqual(
      expect.arrayContaining([
        "unsafe_recovery_performed_without_exact_request",
        "unsafe_recovery_nonmatch_mutation",
      ]),
    );
    expect(
      validateManagedDedicatedCanaryArtifact(confirmationWithoutAcceptance),
    ).toContain("unsafe_recovery_confirmation_without_acceptance");
  });

  test("cleanup failure overrides a successful path and stays red", async () => {
    const { evidence } = await runFixture({
      cleanupFails: true,
      requestLatencyMs: 7,
    });
    expect(evidence.path.successfulPaths).toBe(2);
    expect(evidence.cleanup.status).toBe("failed");
    expect(evidence.cleanup.possibleOrphan).toBe(true);
    expect(evidence.failure).toEqual({
      phase: "cleanup_delete",
      code: "unexpected_http_500",
    });
    expect(evidence.timingsMs.cleanup).toBe(14);
    expect(evidence.verdict).toBe("fail");
    expect(validateManagedDedicatedCanaryArtifact(evidence)).toEqual([]);
  });

  test("the workflow validator rejects skip-like and zero-executed evidence", () => {
    expect(validateManagedDedicatedCanaryEvidence({})).toContain(
      "successful_paths_not_two",
    );
    expect(
      validateManagedDedicatedCanaryEvidence({
        schemaVersion: 3,
        operation: "canary",
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
        recovery: {
          requested: false,
          match: "none",
          performed: "not-attempted",
          confirmed: false,
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
