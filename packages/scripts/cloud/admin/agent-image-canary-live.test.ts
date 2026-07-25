/**
 * Exercises the production canary client with a deterministic HTTP boundary,
 * including credential isolation, strict response correlation, and the
 * committed workflow's privileged-dispatch contract.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AGENT_IMAGE_CANARY_CANONICAL_REPOSITORY,
  AGENT_IMAGE_CANARY_DEMO_REPOSITORY,
  AGENT_IMAGE_CANARY_FIXED_AGENT_ID,
  AGENT_IMAGE_CANARY_PRODUCTION_ORIGIN,
  AGENT_IMAGE_CANARY_RECOVERY_ACTION,
  type AgentImageCanaryEvidence,
  canonicalizeAgentImageCanaryArtifact,
  deriveAgentImageCanaryRequestId,
  readAgentImageCanaryDeploymentCommit,
  runAgentImageCanary,
  validateAgentImageCanaryEvidence,
} from "./agent-image-canary-live";

const SECRET = "eliza_cloud_secret_never_emit";
const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const UPGRADE_JOB_ID = "44444444-4444-4444-8444-444444444444";
const UPGRADE_ROLLOUT_ID = "55555555-5555-4555-8555-555555555555";
const PRIOR_UPGRADE_JOB_ID = "66666666-6666-4666-8666-666666666666";
const PRIOR_UPGRADE_ROLLOUT_ID = "77777777-7777-4777-8777-777777777777";
const ROLLBACK_JOB_ID = "88888888-8888-4888-8888-888888888888";
const ROLLBACK_ROLLOUT_ID = "99999999-9999-4999-8999-999999999999";
const REQUEST_ID = deriveAgentImageCanaryRequestId("123456", "789012");
const PLAN_FINGERPRINT = `sha256:${"d".repeat(64)}`;
const ROLLBACK_PLAN_FINGERPRINT = `sha256:${"e".repeat(64)}`;
const SOURCE_DIGEST = `sha256:${"a".repeat(64)}`;
const TARGET_DIGEST = `sha256:${"b".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"c".repeat(64)}`;
const SOURCE_IMAGE = `${AGENT_IMAGE_CANARY_CANONICAL_REPOSITORY}:sha-production`;
const TARGET_IMAGE = `${AGENT_IMAGE_CANARY_DEMO_REPOSITORY}@${TARGET_DIGEST}`;
const DEPLOYED_COMMIT = "d".repeat(40);
const DECISION_AT = "2026-07-23T12:00:00.000Z";

type FixturePhase =
  | "health"
  | "inventory"
  | "publicToken"
  | "manifest"
  | "upgradeDry"
  | "upgradeExecute"
  | "upgradeRecovery"
  | "upgradePoll"
  | "rollbackDry"
  | "rollbackExecute"
  | "rollbackRecovery"
  | "rollbackPoll";

interface FixtureOptions {
  mode?: "upgrade" | "rollback";
  inventoryContainers?: unknown[];
  status?: Partial<Record<FixturePhase, number>>;
  mutate?: Partial<Record<FixturePhase, (body: unknown) => unknown>>;
  upgradePollBodies?: unknown[];
  rollbackPollBodies?: unknown[];
  manifestDigest?: string | null;
  executeTransportFailure?: boolean;
  recoveryNotFoundCount?: number;
  recoverExistingRequest?: boolean;
  recoveryOnly?: boolean;
  checkpoints?: AgentImageCanaryEvidence[];
}

interface RecordedCall {
  method: string;
  url: string;
  xApiKey: string | null;
  authorization: string | null;
  body: unknown;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function inventoryRow(mode: "upgrade" | "rollback") {
  return {
    id: AGENT_IMAGE_CANARY_FIXED_AGENT_ID,
    organizationId: ORGANIZATION_ID,
    userId: OWNER_ID,
    status: "running",
    dockerImage: mode === "upgrade" ? SOURCE_IMAGE : TARGET_IMAGE,
    imageDigest: mode === "upgrade" ? SOURCE_DIGEST : TARGET_DIGEST,
    nodeId: "private-node-must-not-enter-evidence",
  };
}

function upgradeTarget(jobId?: string) {
  return {
    operation: "upgrade",
    agentId: AGENT_IMAGE_CANARY_FIXED_AGENT_ID,
    organizationId: ORGANIZATION_ID,
    targetOwnerUserId: OWNER_ID,
    sourceImage: SOURCE_IMAGE,
    sourceDigest: SOURCE_DIGEST,
    targetImage: TARGET_IMAGE,
    targetDigest: TARGET_DIGEST,
    ...(jobId ? { jobId, status: "pending" } : {}),
  };
}

function rollbackTarget(
  sourceJobId: string,
  sourceRolloutId: string,
  jobId?: string,
) {
  return {
    operation: "rollback",
    agentId: AGENT_IMAGE_CANARY_FIXED_AGENT_ID,
    organizationId: ORGANIZATION_ID,
    targetOwnerUserId: OWNER_ID,
    sourceImage: TARGET_IMAGE,
    sourceDigest: TARGET_DIGEST,
    targetImage: SOURCE_IMAGE,
    targetDigest: SOURCE_DIGEST,
    sourceRolloutId,
    sourceJobId,
    ...(jobId ? { jobId, status: "pending" } : {}),
  };
}

function rolloutBody(
  operation: "upgrade" | "rollback",
  dryRun: boolean,
  target: ReturnType<typeof upgradeTarget> | ReturnType<typeof rollbackTarget>,
  requestId: string,
) {
  const rolloutId =
    operation === "upgrade" ? UPGRADE_ROLLOUT_ID : ROLLBACK_ROLLOUT_ID;
  const planFingerprint =
    operation === "upgrade" ? PLAN_FINGERPRINT : ROLLBACK_PLAN_FINGERPRINT;
  const body: Record<string, unknown> = {
    success: true,
    data: {
      operation,
      dryRun,
      requestId,
      planFingerprint,
      rolloutId: dryRun ? null : rolloutId,
      decisionAt: DECISION_AT,
      targets: [target],
    },
  };
  if (!dryRun) {
    const jobId = target.jobId;
    body.polling = [
      {
        agentId: AGENT_IMAGE_CANARY_FIXED_AGENT_ID,
        jobId,
        endpoint: `/api/v1/admin/agent-image-canary/jobs/${jobId}`,
        intervalMs: 5_000,
        expectedDurationMs: 180_000,
      },
    ];
    body.recovery = {
      endpoint: `/api/v1/admin/agent-image-canary/requests/${requestId}`,
    };
  }
  return body;
}

function recoveryBody(
  operation: "upgrade" | "rollback",
  target: ReturnType<typeof upgradeTarget> | ReturnType<typeof rollbackTarget>,
  requestId = REQUEST_ID,
) {
  const direct = rolloutBody(operation, false, target, requestId);
  const polling = direct.polling;
  if (!Array.isArray(polling) || !isRecordForTest(polling[0])) {
    throw new Error("fixture recovery polling is missing");
  }
  const response = clone(direct);
  delete response.recovery;
  const recoveredPolling = response.polling;
  if (
    !Array.isArray(recoveredPolling) ||
    !isRecordForTest(recoveredPolling[0])
  ) {
    throw new Error("fixture recovery polling is missing");
  }
  delete recoveredPolling[0].expectedDurationMs;
  recoveredPolling[0].shouldContinue = target.status === "pending";
  return response;
}

function completedPollBody(
  operation: "upgrade" | "rollback",
  jobId: string,
  rolloutId: string,
  target: ReturnType<typeof upgradeTarget> | ReturnType<typeof rollbackTarget>,
) {
  return {
    success: true,
    data: {
      id: jobId,
      type: "agent_admin_canary_image",
      status: "completed",
      result: {
        success: true,
        cleanupPending: false,
        jobId,
        operation,
        rolloutId,
        actorUserId: OWNER_ID,
        decisionAt: DECISION_AT,
        agentId: AGENT_IMAGE_CANARY_FIXED_AGENT_ID,
        organizationId: ORGANIZATION_ID,
        targetOwnerUserId: OWNER_ID,
        sourceImage: target.sourceImage,
        sourceDigest: target.sourceDigest,
        targetImage: target.targetImage,
        targetDigest: target.targetDigest,
        startedAt: "2026-07-23T12:00:01.000Z",
        finishedAt: "2026-07-23T12:02:00.000Z",
      },
      error: null,
      attempts: 0,
      maxAttempts: 1,
    },
    polling: { shouldContinue: false },
  };
}

function pendingPollBody(jobId = UPGRADE_JOB_ID) {
  return {
    success: true,
    data: {
      id: jobId,
      type: "agent_admin_canary_image",
      status: "pending",
      result: null,
      error: null,
    },
    polling: { shouldContinue: true },
  };
}

function createFixture(options: FixtureOptions = {}) {
  const mode = options.mode ?? "upgrade";
  const calls: RecordedCall[] = [];
  let recoveryNotFoundCount = options.recoveryNotFoundCount ?? 0;
  const upgradePollBodies = [
    ...(options.upgradePollBodies ?? [
      completedPollBody(
        "upgrade",
        UPGRADE_JOB_ID,
        UPGRADE_ROLLOUT_ID,
        upgradeTarget(),
      ),
    ]),
  ];
  const rollbackPollBodies = [
    ...(options.rollbackPollBodies ?? [
      completedPollBody(
        "rollback",
        ROLLBACK_JOB_ID,
        ROLLBACK_ROLLOUT_ID,
        rollbackTarget(PRIOR_UPGRADE_JOB_ID, PRIOR_UPGRADE_ROLLOUT_ID),
      ),
    ]),
  ];

  function reply(
    phase: FixturePhase,
    defaultBody: unknown,
    defaultStatus = 200,
    headers?: HeadersInit,
  ): Response {
    const body = options.mutate?.[phase]
      ? options.mutate[phase]?.(clone(defaultBody))
      : defaultBody;
    return jsonResponse(
      body,
      options.status?.[phase] ?? defaultStatus,
      headers,
    );
  }

  const fetch = async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers = new Headers(init.headers);
    const requestBody =
      typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({
      method: init.method ?? "GET",
      url: url.toString(),
      xApiKey: headers.get("x-api-key"),
      authorization: headers.get("authorization"),
      body: requestBody,
    });

    if (url.origin === AGENT_IMAGE_CANARY_PRODUCTION_ORIGIN) {
      if (url.pathname === "/api/health") {
        return reply("health", {
          status: "ok",
          environment: "production",
          commit: DEPLOYED_COMMIT,
        });
      }
      if (url.pathname === "/api/v1/admin/docker-containers") {
        return reply("inventory", {
          success: true,
          data: {
            containers: options.inventoryContainers ?? [inventoryRow(mode)],
            total: 1,
            returned: 1,
          },
        });
      }
      if (
        url.pathname === "/api/v1/admin/agent-image-canary" &&
        init.method === "POST"
      ) {
        if (!isRecordForTest(requestBody)) {
          return jsonResponse({ error: "bad fixture request" }, 599);
        }
        const requestId = String(requestBody.requestId ?? "");
        if (requestBody.operation === "upgrade") {
          const dryRun = requestBody.dryRun === true;
          if (!dryRun && options.executeTransportFailure) {
            throw new TypeError(
              "fixture accepted request before connection loss",
            );
          }
          return reply(
            dryRun ? "upgradeDry" : "upgradeExecute",
            rolloutBody(
              "upgrade",
              dryRun,
              upgradeTarget(dryRun ? undefined : UPGRADE_JOB_ID),
              requestId,
            ),
            dryRun ? 200 : 202,
          );
        }
        if (requestBody.operation === "rollback") {
          const dryRun = requestBody.dryRun === true;
          if (!dryRun && options.executeTransportFailure) {
            throw new TypeError(
              "fixture accepted request before connection loss",
            );
          }
          const source = isRecordForTest(requestBody.source)
            ? requestBody.source
            : {};
          const sourceJobId = String(source.jobId ?? "");
          const sourceRolloutId =
            sourceJobId === UPGRADE_JOB_ID
              ? UPGRADE_ROLLOUT_ID
              : PRIOR_UPGRADE_ROLLOUT_ID;
          return reply(
            dryRun ? "rollbackDry" : "rollbackExecute",
            rolloutBody(
              "rollback",
              dryRun,
              rollbackTarget(
                sourceJobId,
                sourceRolloutId,
                dryRun ? undefined : ROLLBACK_JOB_ID,
              ),
              requestId,
            ),
            dryRun ? 200 : 202,
          );
        }
      }
      if (
        url.pathname ===
          `/api/v1/admin/agent-image-canary/requests/${REQUEST_ID}` &&
        init.method === "GET"
      ) {
        if (recoveryNotFoundCount > 0) {
          recoveryNotFoundCount -= 1;
          return jsonResponse(
            { success: false, error: { code: "not_found" } },
            404,
          );
        }
        return mode === "upgrade"
          ? reply(
              "upgradeRecovery",
              recoveryBody("upgrade", upgradeTarget(UPGRADE_JOB_ID)),
            )
          : reply(
              "rollbackRecovery",
              recoveryBody(
                "rollback",
                rollbackTarget(
                  PRIOR_UPGRADE_JOB_ID,
                  PRIOR_UPGRADE_ROLLOUT_ID,
                  ROLLBACK_JOB_ID,
                ),
              ),
            );
      }
      if (
        url.pathname ===
        `/api/v1/admin/agent-image-canary/jobs/${UPGRADE_JOB_ID}`
      ) {
        const body =
          upgradePollBodies.shift() ??
          completedPollBody(
            "upgrade",
            UPGRADE_JOB_ID,
            UPGRADE_ROLLOUT_ID,
            upgradeTarget(),
          );
        return reply("upgradePoll", body);
      }
      if (
        url.pathname ===
        `/api/v1/admin/agent-image-canary/jobs/${ROLLBACK_JOB_ID}`
      ) {
        const body =
          rollbackPollBodies.shift() ??
          completedPollBody(
            "rollback",
            ROLLBACK_JOB_ID,
            ROLLBACK_ROLLOUT_ID,
            rollbackTarget(PRIOR_UPGRADE_JOB_ID, PRIOR_UPGRADE_ROLLOUT_ID),
          );
        return reply("rollbackPoll", body);
      }
    }

    if (url.hostname === "ghcr.io" && url.pathname === "/token") {
      return reply("publicToken", { token: "public_registry_token" });
    }
    if (
      url.hostname === "ghcr.io" &&
      url.pathname === `/v2/elizaos/eliza-demo/manifests/${TARGET_DIGEST}`
    ) {
      return reply(
        "manifest",
        { schemaVersion: 2 },
        200,
        options.manifestDigest === null
          ? {}
          : {
              "docker-content-digest": options.manifestDigest ?? TARGET_DIGEST,
            },
      );
    }
    return jsonResponse({ error: "unexpected fixture request" }, 599);
  };

  return { fetch: fetch as typeof globalThis.fetch, calls };
}

function isRecordForTest(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runFixture(options: FixtureOptions = {}) {
  const fixture = createFixture(options);
  let nowMs = Date.parse("2026-07-23T12:00:00.000Z");
  const mode = options.mode ?? "upgrade";
  const evidence = await runAgentImageCanary({
    apiKey: SECRET,
    mode,
    requestId: REQUEST_ID,
    expectedDeployCommit: DEPLOYED_COMMIT,
    targetDigest: mode === "upgrade" ? TARGET_DIGEST : undefined,
    sourceJobId: mode === "rollback" ? PRIOR_UPGRADE_JOB_ID : undefined,
    fetch: fixture.fetch,
    now: () => nowMs,
    sleep: async (ms: number) => {
      nowMs += ms;
    },
    pollIntervalMs: 5,
    pollTimeoutMs: 25,
    recoverExistingRequest: options.recoverExistingRequest,
    recoveryOnly: options.recoveryOnly,
    checkpoint: options.checkpoints
      ? async (checkpoint) => {
          options.checkpoints?.push(clone(checkpoint));
        }
      : undefined,
  });
  return { evidence, calls: fixture.calls };
}

function mutateRecord(
  body: unknown,
  mutate: (record: Record<string, unknown>) => void,
): unknown {
  if (!isRecordForTest(body)) throw new Error("fixture body is not an object");
  mutate(body);
  return body;
}

describe("agent image canary live client", () => {
  test("upgrade proves one exact public image and only previews rollback", async () => {
    const { evidence, calls } = await runFixture();
    expect(evidence).toMatchObject({
      verdict: "pass",
      mode: "upgrade",
      deployedCommit: DEPLOYED_COMMIT,
      image: {
        sourceRepository: AGENT_IMAGE_CANARY_CANONICAL_REPOSITORY,
        sourceDigest: SOURCE_DIGEST,
        targetRepository: AGENT_IMAGE_CANARY_DEMO_REPOSITORY,
        targetDigest: TARGET_DIGEST,
        publicTargetVerified: true,
      },
      execution: {
        requestId: REQUEST_ID,
        planFingerprint: PLAN_FINGERPRINT,
        recoveryOnly: false,
        inventoryMatched: true,
        dryRunPassed: true,
        executeAccepted: true,
        recovered: false,
        recoveryRequired: false,
        recoveryAction: null,
        sourceJobId: null,
        jobId: UPGRADE_JOB_ID,
        terminalStatus: "completed",
        pollCount: 1,
        rollbackDryRunPassed: true,
      },
      failure: null,
    });
    expect(validateAgentImageCanaryEvidence(evidence)).toEqual([]);

    const artifact = JSON.stringify(evidence);
    for (const forbidden of [
      SECRET,
      AGENT_IMAGE_CANARY_FIXED_AGENT_ID,
      ORGANIZATION_ID,
      OWNER_ID,
      "private-node-must-not-enter-evidence",
      SOURCE_IMAGE,
    ]) {
      expect(artifact).not.toContain(forbidden);
    }

    expect(
      calls.map((call) => [call.method, new URL(call.url).pathname]),
    ).toEqual([
      ["GET", "/api/health"],
      ["GET", "/api/v1/admin/docker-containers"],
      ["GET", "/token"],
      ["GET", `/v2/elizaos/eliza-demo/manifests/${TARGET_DIGEST}`],
      ["POST", "/api/v1/admin/agent-image-canary"],
      ["POST", "/api/v1/admin/agent-image-canary"],
      ["GET", `/api/v1/admin/agent-image-canary/jobs/${UPGRADE_JOB_ID}`],
      ["POST", "/api/v1/admin/agent-image-canary"],
    ]);
    const cloudCalls = calls.filter((call) =>
      call.url.startsWith(AGENT_IMAGE_CANARY_PRODUCTION_ORIGIN),
    );
    expect(cloudCalls[0]?.xApiKey).toBeNull();
    for (const call of cloudCalls.slice(1)) {
      expect(call.xApiKey).toBe(SECRET);
      expect(call.authorization).toBeNull();
    }
    for (const call of calls.filter((item) =>
      item.url.startsWith("https://ghcr.io/"),
    )) {
      expect(call.xApiKey).toBeNull();
      expect(call.authorization).not.toBe(SECRET);
    }

    const rollbackPosts = calls.filter(
      (call) =>
        isRecordForTest(call.body) && call.body.operation === "rollback",
    );
    expect(rollbackPosts).toHaveLength(1);
    expect(rollbackPosts[0]?.body).toMatchObject({
      operation: "rollback",
      dryRun: true,
      source: { jobId: UPGRADE_JOB_ID },
    });
    const rollbackBody = rollbackPosts[0]?.body;
    expect(isRecordForTest(rollbackBody)).toBe(true);
    if (!isRecordForTest(rollbackBody)) throw new Error("bad fixture");
    expect(rollbackBody.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(rollbackBody.requestId).not.toBe(REQUEST_ID);

    const upgradePosts = calls.filter(
      (call) => isRecordForTest(call.body) && call.body.operation === "upgrade",
    );
    expect(upgradePosts).toHaveLength(2);
    expect(upgradePosts[0]?.body).toMatchObject({
      operation: "upgrade",
      requestId: REQUEST_ID,
      dryRun: true,
    });
    expect(upgradePosts[0]?.body).not.toHaveProperty("expectedPlanFingerprint");
    expect(upgradePosts[1]?.body).toMatchObject({
      operation: "upgrade",
      requestId: REQUEST_ID,
      dryRun: false,
      expectedPlanFingerprint: PLAN_FINGERPRINT,
    });
  });

  test("rollback previews, executes, and polls the exact prior job", async () => {
    const { evidence, calls } = await runFixture({ mode: "rollback" });
    expect(evidence).toMatchObject({
      verdict: "pass",
      mode: "rollback",
      image: {
        sourceRepository: AGENT_IMAGE_CANARY_DEMO_REPOSITORY,
        sourceDigest: TARGET_DIGEST,
        targetRepository: AGENT_IMAGE_CANARY_CANONICAL_REPOSITORY,
        targetDigest: SOURCE_DIGEST,
        publicTargetVerified: false,
      },
      execution: {
        requestId: REQUEST_ID,
        planFingerprint: ROLLBACK_PLAN_FINGERPRINT,
        recoveryOnly: false,
        recovered: false,
        recoveryRequired: false,
        recoveryAction: null,
        sourceJobId: PRIOR_UPGRADE_JOB_ID,
        jobId: ROLLBACK_JOB_ID,
        terminalStatus: "completed",
        rollbackDryRunPassed: false,
      },
      failure: null,
    });
    expect(validateAgentImageCanaryEvidence(evidence)).toEqual([]);
    expect(calls.some((call) => call.url.includes("ghcr.io"))).toBe(false);
    const rollbackPosts = calls.filter(
      (call) =>
        isRecordForTest(call.body) && call.body.operation === "rollback",
    );
    expect(rollbackPosts.map((call) => call.body)).toEqual([
      {
        operation: "rollback",
        requestId: REQUEST_ID,
        dryRun: true,
        source: { jobId: PRIOR_UPGRADE_JOB_ID },
      },
      {
        operation: "rollback",
        requestId: REQUEST_ID,
        dryRun: false,
        expectedPlanFingerprint: ROLLBACK_PLAN_FINGERPRINT,
        source: { jobId: PRIOR_UPGRADE_JOB_ID },
      },
    ]);
  });

  test("derives one stable UUIDv5 from repository and run identity", () => {
    const first = deriveAgentImageCanaryRequestId("123456", "789012");
    const repeated = deriveAgentImageCanaryRequestId("123456", "789012");
    const anotherRun = deriveAgentImageCanaryRequestId("123456", "789013");
    expect(first).toBe(REQUEST_ID);
    expect(repeated).toBe(first);
    expect(anotherRun).not.toBe(first);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(() => deriveAgentImageCanaryRequestId("0", "789012")).toThrow(
      "invalid_github_run_identity",
    );
  });

  test("checkpoints intent before execute and accepted identity before polling", async () => {
    const checkpoints: AgentImageCanaryEvidence[] = [];
    const { evidence } = await runFixture({ checkpoints });
    expect(evidence.verdict).toBe("pass");
    expect(checkpoints).toHaveLength(3);
    expect(checkpoints[0]).toMatchObject({
      verdict: "pending",
      execution: {
        requestId: REQUEST_ID,
        planFingerprint: PLAN_FINGERPRINT,
        dryRunPassed: true,
        executeAccepted: false,
        jobId: null,
        terminalStatus: null,
      },
    });
    expect(checkpoints[1]).toMatchObject({
      verdict: "pending",
      execution: {
        requestId: REQUEST_ID,
        planFingerprint: PLAN_FINGERPRINT,
        executeAccepted: true,
        jobId: UPGRADE_JOB_ID,
        terminalStatus: null,
      },
    });
    expect(checkpoints[2]).toMatchObject({
      verdict: "pending",
      execution: {
        executeAccepted: true,
        jobId: UPGRADE_JOB_ID,
        terminalStatus: "completed",
        rollbackDryRunPassed: false,
      },
    });
    for (const checkpoint of checkpoints) {
      expect(validateAgentImageCanaryEvidence(checkpoint)).toEqual([]);
    }
  });

  test("recovers a transport-ambiguous execute without issuing a second mutation", async () => {
    const { evidence, calls } = await runFixture({
      executeTransportFailure: true,
    });
    expect(evidence).toMatchObject({
      verdict: "pass",
      execution: {
        requestId: REQUEST_ID,
        planFingerprint: PLAN_FINGERPRINT,
        executeAccepted: true,
        recovered: true,
        recoveryRequired: false,
        jobId: UPGRADE_JOB_ID,
        terminalStatus: "completed",
      },
    });
    const executePosts = calls.filter(
      (call) =>
        call.method === "POST" &&
        isRecordForTest(call.body) &&
        call.body.operation === "upgrade" &&
        call.body.dryRun === false,
    );
    expect(executePosts).toHaveLength(1);
    expect(
      calls.filter(
        (call) =>
          call.method === "GET" &&
          new URL(call.url).pathname ===
            `/api/v1/admin/agent-image-canary/requests/${REQUEST_ID}`,
      ),
    ).toHaveLength(1);
  });

  test("replays only the identical execute after recovery proves absence", async () => {
    const { evidence, calls } = await runFixture({
      executeTransportFailure: true,
      recoveryNotFoundCount: 1,
    });
    expect(evidence).toMatchObject({
      verdict: "pass",
      execution: {
        requestId: REQUEST_ID,
        recovered: true,
        jobId: UPGRADE_JOB_ID,
      },
    });
    const executePosts = calls.filter(
      (call) =>
        call.method === "POST" &&
        isRecordForTest(call.body) &&
        call.body.operation === "upgrade" &&
        call.body.dryRun === false,
    );
    expect(executePosts).toHaveLength(2);
    expect(executePosts[1]?.body).toEqual(executePosts[0]?.body);
    expect(
      calls.filter(
        (call) =>
          call.method === "GET" &&
          new URL(call.url).pathname ===
            `/api/v1/admin/agent-image-canary/requests/${REQUEST_ID}`,
      ),
    ).toHaveLength(2);
  });

  test("keeps an ambiguous execute nonterminal when recovery authentication fails", async () => {
    const { evidence } = await runFixture({
      executeTransportFailure: true,
      status: { upgradeRecovery: 403 },
    });
    expect(evidence).toMatchObject({
      verdict: "nonterminal",
      execution: {
        requestId: REQUEST_ID,
        executeAccepted: false,
        recoveryRequired: true,
        recoveryAction: AGENT_IMAGE_CANARY_RECOVERY_ACTION,
        terminalStatus: null,
      },
      failure: { phase: "execute", code: "auth_denied" },
    });
    expect(validateAgentImageCanaryEvidence(evidence)).toEqual([]);
  });

  test("rerun resumes the durable request before any new preview or execute", async () => {
    const { evidence, calls } = await runFixture({
      recoverExistingRequest: true,
    });
    expect(evidence).toMatchObject({
      verdict: "pass",
      execution: {
        requestId: REQUEST_ID,
        inventoryMatched: false,
        dryRunPassed: true,
        executeAccepted: true,
        recovered: true,
        jobId: UPGRADE_JOB_ID,
        terminalStatus: "completed",
      },
    });
    expect(
      calls.map((call) => [call.method, new URL(call.url).pathname]),
    ).toEqual([
      ["GET", "/api/health"],
      ["GET", `/api/v1/admin/agent-image-canary/requests/${REQUEST_ID}`],
      ["GET", `/api/v1/admin/agent-image-canary/jobs/${UPGRADE_JOB_ID}`],
      ["GET", "/token"],
      ["GET", `/v2/elizaos/eliza-demo/manifests/${TARGET_DIGEST}`],
      ["POST", "/api/v1/admin/agent-image-canary"],
    ]);
    expect(
      calls.some(
        (call) =>
          new URL(call.url).pathname === "/api/v1/admin/docker-containers",
      ),
    ).toBe(false);
  });

  test("a current-main recovery dispatch resumes an older durable request with GETs only", async () => {
    const { evidence, calls } = await runFixture({
      recoverExistingRequest: true,
      recoveryOnly: true,
    });
    expect(evidence).toMatchObject({
      verdict: "pass",
      execution: {
        requestId: REQUEST_ID,
        recoveryOnly: true,
        inventoryMatched: false,
        dryRunPassed: true,
        executeAccepted: true,
        recovered: true,
        jobId: UPGRADE_JOB_ID,
        terminalStatus: "completed",
        rollbackDryRunPassed: false,
      },
    });
    expect(validateAgentImageCanaryEvidence(evidence)).toEqual([]);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/health",
      `/api/v1/admin/agent-image-canary/requests/${REQUEST_ID}`,
      `/api/v1/admin/agent-image-canary/jobs/${UPGRADE_JOB_ID}`,
      "/token",
      `/v2/elizaos/eliza-demo/manifests/${TARGET_DIGEST}`,
    ]);
  });

  test("recovery-only 404 remains nonterminal and never previews or executes", async () => {
    const { evidence, calls } = await runFixture({
      recoverExistingRequest: true,
      recoveryOnly: true,
      recoveryNotFoundCount: 1,
    });
    expect(evidence).toMatchObject({
      verdict: "nonterminal",
      execution: {
        requestId: REQUEST_ID,
        recoveryOnly: true,
        executeAccepted: false,
        recoveryRequired: true,
        recoveryAction: AGENT_IMAGE_CANARY_RECOVERY_ACTION,
        jobId: null,
        terminalStatus: null,
      },
      failure: { phase: "recovery", code: "recovery_not_found" },
    });
    expect(validateAgentImageCanaryEvidence(evidence)).toEqual([]);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect(
      calls.some(
        (call) =>
          new URL(call.url).pathname === "/api/v1/admin/docker-containers",
      ),
    ).toBe(false);
  });

  test("recovery-only auth or identity mismatch remains nonterminal without POSTs", async () => {
    const denied = await runFixture({
      recoverExistingRequest: true,
      recoveryOnly: true,
      status: { upgradeRecovery: 403 },
    });
    expect(denied.evidence).toMatchObject({
      verdict: "nonterminal",
      execution: {
        recoveryOnly: true,
        recoveryRequired: true,
        recoveryAction: AGENT_IMAGE_CANARY_RECOVERY_ACTION,
      },
      failure: { phase: "recovery", code: "auth_denied" },
    });
    expect(validateAgentImageCanaryEvidence(denied.evidence)).toEqual([]);
    expect(denied.calls.some((call) => call.method === "POST")).toBe(false);

    const mismatched = await runFixture({
      recoverExistingRequest: true,
      recoveryOnly: true,
      mutate: {
        upgradeRecovery: (body) =>
          mutateRecord(body, (record) => {
            const data = record.data;
            if (!isRecordForTest(data) || !Array.isArray(data.targets)) {
              throw new Error("bad fixture");
            }
            const target = data.targets[0];
            if (!isRecordForTest(target)) throw new Error("bad fixture");
            target.agentId = OTHER_AGENT_ID;
          }),
      },
    });
    expect(mismatched.evidence).toMatchObject({
      verdict: "nonterminal",
      execution: {
        recoveryOnly: true,
        recoveryRequired: true,
        recoveryAction: AGENT_IMAGE_CANARY_RECOVERY_ACTION,
      },
      failure: { phase: "recovery", code: "invalid_response_shape" },
    });
    expect(validateAgentImageCanaryEvidence(mismatched.evidence)).toEqual([]);
    expect(mismatched.calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("poll timeout is explicitly nonterminal with exact rerun recovery", async () => {
    const { evidence } = await runFixture({
      upgradePollBodies: Array.from({ length: 6 }, () => pendingPollBody()),
    });
    expect(evidence).toMatchObject({
      verdict: "nonterminal",
      execution: {
        requestId: REQUEST_ID,
        planFingerprint: PLAN_FINGERPRINT,
        executeAccepted: true,
        recoveryRequired: true,
        recoveryAction: AGENT_IMAGE_CANARY_RECOVERY_ACTION,
        jobId: UPGRADE_JOB_ID,
        terminalStatus: null,
        pollCount: 6,
      },
      failure: { phase: "poll", code: "poll_timeout" },
    });
    expect(validateAgentImageCanaryEvidence(evidence)).toEqual([]);
  });

  test.each([
    {
      name: "missing key",
      options: {
        apiKey: "",
        mode: "upgrade",
        targetDigest: TARGET_DIGEST,
      },
      code: "missing_cloud_credential",
    },
    {
      name: "key with whitespace",
      options: {
        apiKey: `${SECRET}\n`,
        mode: "upgrade",
        targetDigest: TARGET_DIGEST,
      },
      code: "missing_cloud_credential",
    },
    {
      name: "missing trusted deploy commit",
      options: {
        apiKey: SECRET,
        mode: "upgrade",
        targetDigest: TARGET_DIGEST,
        expectedDeployCommit: "",
      },
      code: "missing_trusted_deploy_commit",
    },
    {
      name: "non-production origin",
      options: {
        apiKey: SECRET,
        mode: "upgrade",
        targetDigest: TARGET_DIGEST,
        baseUrl: "https://api-staging.elizacloud.ai",
      },
      code: "non_production_target_refused",
    },
    {
      name: "production origin with path",
      options: {
        apiKey: SECRET,
        mode: "upgrade",
        targetDigest: TARGET_DIGEST,
        baseUrl: "https://api.elizacloud.ai/extra",
      },
      code: "non_production_target_refused",
    },
    {
      name: "invalid request ID",
      options: {
        apiKey: SECRET,
        mode: "upgrade",
        requestId: "same-run",
        recoverExistingRequest: true,
        recoveryOnly: true,
        targetDigest: TARGET_DIGEST,
      },
      code: "invalid_request_id",
    },
    {
      name: "unknown mode",
      options: { apiKey: SECRET, mode: "plan" },
      code: "invalid_mode_contract",
    },
    {
      name: "upgrade without digest",
      options: { apiKey: SECRET, mode: "upgrade" },
      code: "invalid_target_digest",
    },
    {
      name: "uppercase digest",
      options: {
        apiKey: SECRET,
        mode: "upgrade",
        targetDigest: `sha256:${"B".repeat(64)}`,
      },
      code: "invalid_target_digest",
    },
    {
      name: "upgrade with rollback job",
      options: {
        apiKey: SECRET,
        mode: "upgrade",
        targetDigest: TARGET_DIGEST,
        sourceJobId: PRIOR_UPGRADE_JOB_ID,
      },
      code: "invalid_mode_contract",
    },
    {
      name: "rollback without job",
      options: { apiKey: SECRET, mode: "rollback" },
      code: "invalid_source_job_id",
    },
    {
      name: "rollback with digest",
      options: {
        apiKey: SECRET,
        mode: "rollback",
        sourceJobId: PRIOR_UPGRADE_JOB_ID,
        targetDigest: TARGET_DIGEST,
      },
      code: "invalid_mode_contract",
    },
  ])("rejects invalid configuration: $name", async ({ options, code }) => {
    let fetchCalls = 0;
    const evidence = await runAgentImageCanary({
      expectedDeployCommit: DEPLOYED_COMMIT,
      requestId: REQUEST_ID,
      ...options,
      fetch: (async () => {
        fetchCalls += 1;
        return jsonResponse({});
      }) as unknown as typeof globalThis.fetch,
    });
    expect(evidence.verdict).toBe("fail");
    expect(evidence.failure).toEqual({ phase: "config", code });
    expect(fetchCalls).toBe(0);
    expect(JSON.stringify(evidence)).not.toContain(SECRET);
    expect(validateAgentImageCanaryEvidence(evidence)).toEqual([]);
  });

  test("fails closed when the API key is not super-admin", async () => {
    const { evidence, calls } = await runFixture({
      status: { inventory: 403 },
    });
    expect(evidence.failure).toEqual({
      phase: "inventory",
      code: "auth_denied",
    });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect(JSON.stringify(evidence)).not.toContain(SECRET);
  });

  test("rejects deploy drift before the first credentialed request", async () => {
    const fixture = createFixture({
      mutate: {
        health: (body) =>
          mutateRecord(body, (record) => {
            record.commit = "e".repeat(40);
          }),
      },
    });
    const observedCommit = await readAgentImageCanaryDeploymentCommit({
      fetch: fixture.fetch,
    });
    expect(observedCommit).toBe("e".repeat(40));

    const evidence = await runAgentImageCanary({
      apiKey: SECRET,
      mode: "upgrade",
      requestId: REQUEST_ID,
      expectedDeployCommit: DEPLOYED_COMMIT,
      targetDigest: TARGET_DIGEST,
      fetch: fixture.fetch,
    });
    expect(evidence.failure).toEqual({
      phase: "health",
      code: "deployed_commit_changed",
    });
    expect(
      fixture.calls.filter(
        (call) =>
          call.url.startsWith(AGENT_IMAGE_CANARY_PRODUCTION_ORIGIN) &&
          call.xApiKey !== null,
      ),
    ).toHaveLength(0);
  });

  test("rejects duplicate fixed-agent inventory rows", async () => {
    const row = inventoryRow("upgrade");
    const { evidence, calls } = await runFixture({
      inventoryContainers: [row, clone(row)],
    });
    expect(evidence.failure).toEqual({
      phase: "inventory",
      code: "duplicate_target",
    });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("rejects inventory without the authoritative image digest", async () => {
    const row = inventoryRow("upgrade");
    delete (row as { imageDigest?: string }).imageDigest;
    const { evidence } = await runFixture({
      inventoryContainers: [row],
    });
    expect(evidence.failure).toEqual({
      phase: "inventory",
      code: "missing_source_pair",
    });
  });

  test("rejects an inaccessible or digest-mismatched demo image before POST", async () => {
    const inaccessible = await runFixture({
      status: { publicToken: 403 },
    });
    expect(inaccessible.evidence.failure).toEqual({
      phase: "public_image",
      code: "image_not_public",
    });
    expect(inaccessible.calls.some((call) => call.method === "POST")).toBe(
      false,
    );

    const mismatched = await runFixture({
      manifestDigest: OTHER_DIGEST,
    });
    expect(mismatched.evidence.failure).toEqual({
      phase: "public_image",
      code: "image_not_public",
    });
    expect(mismatched.calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("rejects duplicate and inconsistent dry-run targets before execute", async () => {
    const duplicate = await runFixture({
      mutate: {
        upgradeDry: (body) =>
          mutateRecord(body, (record) => {
            const data = record.data;
            if (!isRecordForTest(data) || !Array.isArray(data.targets)) {
              throw new Error("bad fixture");
            }
            data.targets.push(clone(data.targets[0]));
          }),
      },
    });
    expect(duplicate.evidence.failure).toEqual({
      phase: "dry_run",
      code: "invalid_response_shape",
    });

    const inconsistent = await runFixture({
      mutate: {
        upgradeDry: (body) =>
          mutateRecord(body, (record) => {
            const data = record.data;
            if (!isRecordForTest(data) || !Array.isArray(data.targets)) {
              throw new Error("bad fixture");
            }
            const target = data.targets[0];
            if (!isRecordForTest(target)) throw new Error("bad fixture");
            target.agentId = OTHER_AGENT_ID;
          }),
      },
    });
    expect(inconsistent.evidence.failure).toEqual({
      phase: "dry_run",
      code: "dry_run_mismatch",
    });
    expect(
      inconsistent.calls.filter((call) => call.method === "POST"),
    ).toHaveLength(1);
  });

  test("recovers an inconsistent accepted envelope from durable state", async () => {
    const { evidence, calls } = await runFixture({
      mutate: {
        upgradeExecute: (body) =>
          mutateRecord(body, (record) => {
            const data = record.data;
            if (!isRecordForTest(data) || !Array.isArray(data.targets)) {
              throw new Error("bad fixture");
            }
            const target = data.targets[0];
            if (!isRecordForTest(target)) throw new Error("bad fixture");
            target.sourceDigest = OTHER_DIGEST;
          }),
      },
    });
    expect(evidence).toMatchObject({
      verdict: "pass",
      execution: {
        executeAccepted: true,
        recovered: true,
        recoveryRequired: false,
        jobId: UPGRADE_JOB_ID,
      },
    });
    expect(
      calls.some(
        (call) =>
          new URL(call.url).pathname ===
          `/api/v1/admin/agent-image-canary/requests/${REQUEST_ID}`,
      ),
    ).toBe(true);
  });

  test("fails on terminal job failure and contradictory nonterminal polling", async () => {
    const failed = await runFixture({
      upgradePollBodies: [
        {
          success: true,
          data: {
            id: UPGRADE_JOB_ID,
            type: "agent_admin_canary_image",
            status: "failed",
            result: null,
            error: "private server detail",
          },
          polling: { shouldContinue: false },
        },
      ],
    });
    expect(failed.evidence.failure).toEqual({
      phase: "poll",
      code: "job_failed",
    });
    expect(failed.evidence.execution.terminalStatus).toBe("failed");
    expect(JSON.stringify(failed.evidence)).not.toContain(
      "private server detail",
    );

    const contradictory = await runFixture({
      upgradePollBodies: [
        {
          success: true,
          data: {
            id: UPGRADE_JOB_ID,
            type: "agent_admin_canary_image",
            status: "pending",
          },
          polling: { shouldContinue: false },
        },
      ],
    });
    expect(contradictory.evidence.failure).toEqual({
      phase: "poll",
      code: "job_nonterminal",
    });
  });

  test("rejects a completed job whose audit pair changed", async () => {
    const { evidence } = await runFixture({
      mutate: {
        upgradePoll: (body) =>
          mutateRecord(body, (record) => {
            const data = record.data;
            if (!isRecordForTest(data) || !isRecordForTest(data.result)) {
              throw new Error("bad fixture");
            }
            data.result.targetDigest = OTHER_DIGEST;
          }),
      },
    });
    expect(evidence.failure).toEqual({
      phase: "poll",
      code: "source_pair_mismatch",
    });
  });

  test("retains the completed upgrade job ID when rollback preview is inconsistent", async () => {
    const { evidence } = await runFixture({
      mutate: {
        rollbackDry: (body) =>
          mutateRecord(body, (record) => {
            const data = record.data;
            if (!isRecordForTest(data) || !Array.isArray(data.targets)) {
              throw new Error("bad fixture");
            }
            const target = data.targets[0];
            if (!isRecordForTest(target)) throw new Error("bad fixture");
            target.targetDigest = OTHER_DIGEST;
          }),
      },
    });
    expect(evidence).toMatchObject({
      verdict: "fail",
      execution: {
        executeAccepted: true,
        jobId: UPGRADE_JOB_ID,
        terminalStatus: "completed",
        rollbackDryRunPassed: false,
      },
      failure: {
        phase: "rollback_dry_run",
        code: "rollback_pair_mismatch",
      },
    });
  });

  test("rollback rejects a preview bound to a different prior job", async () => {
    const { evidence } = await runFixture({
      mode: "rollback",
      mutate: {
        rollbackDry: (body) =>
          mutateRecord(body, (record) => {
            const data = record.data;
            if (!isRecordForTest(data) || !Array.isArray(data.targets)) {
              throw new Error("bad fixture");
            }
            const target = data.targets[0];
            if (!isRecordForTest(target)) throw new Error("bad fixture");
            target.sourceJobId = UPGRADE_JOB_ID;
          }),
      },
    });
    expect(evidence.failure).toEqual({
      phase: "dry_run",
      code: "dry_run_mismatch",
    });
  });
});

describe("privacy-safe evidence boundary", () => {
  test("canonicalizes an allowlisted artifact and rejects added sensitive fields", async () => {
    const { evidence } = await runFixture();
    const raw = JSON.stringify(evidence);
    const canonical = canonicalizeAgentImageCanaryArtifact(raw);
    expect(canonical.errors).toEqual([]);
    expect(canonical.canonical).not.toContain(SECRET);

    for (const [key, value] of [
      ["userId", OWNER_ID],
      ["apiKey", SECRET],
      ["responseBody", { secret: SECRET }],
    ] as const) {
      const poisoned = { ...clone(evidence), [key]: value };
      const result = canonicalizeAgentImageCanaryArtifact(
        JSON.stringify(poisoned),
      );
      expect(result.canonical).toBeNull();
      expect(result.errors).toContain("unexpected_top_level_keys");
    }
  });
});

describe("admin agent image canary workflow", () => {
  test("is a single production-only manual mutation lane", () => {
    const workflowPath = resolve(
      import.meta.dir,
      "../../../../.github/workflows/admin-agent-image-canary.yml",
    );
    const source = readFileSync(workflowPath, "utf8");
    const workflow = Bun.YAML.parse(source) as {
      on?: Record<string, unknown>;
      concurrency?: { group?: string; "cancel-in-progress"?: boolean };
      permissions?: Record<string, string>;
      jobs?: Record<
        string,
        {
          environment?: string;
          timeoutMinutes?: number;
          steps?: Array<{
            name?: string;
            run?: string;
            env?: Record<string, string>;
            with?: Record<string, string>;
          }>;
        }
      >;
    };

    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    const dispatch = workflow.on?.workflow_dispatch as {
      inputs?: Record<string, unknown>;
    };
    expect(Object.keys(dispatch.inputs ?? {}).sort()).toEqual([
      "mode",
      "prior_upgrade_job_id",
      "recovery_request_id",
      "target_digest",
    ]);
    expect(dispatch.inputs?.recovery_request_id).toMatchObject({
      required: false,
      type: "string",
    });
    expect(dispatch.inputs).not.toHaveProperty("agent_id");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "production-admin-agent-image-canary",
      "cancel-in-progress": false,
    });
    const job = workflow.jobs?.canary;
    expect(job?.environment).toBe("production");
    const steps = job?.steps ?? [];
    const stepNames = steps.map((step) => step.name);
    const requestIndex = stepNames.indexOf(
      "Select stable actor-bound request ID",
    );
    const preDeployIndex = stepNames.indexOf(
      "Verify trusted production deployment before mutation",
    );
    const liveIndex = stepNames.indexOf("Run bounded production canary");
    const postDeployIndex = stepNames.indexOf(
      "Verify production deployment did not drift",
    );
    expect(requestIndex).toBeGreaterThan(-1);
    expect(preDeployIndex).toBeGreaterThan(requestIndex);
    expect(liveIndex).toBeGreaterThan(preDeployIndex);
    expect(postDeployIndex).toBeGreaterThan(liveIndex);
    expect(steps[preDeployIndex]?.env).not.toHaveProperty("ELIZACLOUD_API_KEY");
    expect(steps[requestIndex]?.env).toMatchObject({
      REPOSITORY_ID: "$" + "{{ github.repository_id }}",
      RUN_ID: "$" + "{{ github.run_id }}",
      RUN_ATTEMPT: "$" + "{{ github.run_attempt }}",
      RECOVERY_REQUEST_ID: "$" + "{{ inputs.recovery_request_id }}",
    });
    expect(steps[requestIndex]?.run?.replaceAll(/\s+/g, " ")).toContain(
      'deriveAgentImageCanaryRequestId( process.env.REPOSITORY_ID ?? "", process.env.RUN_ID ?? "", )',
    );
    expect(steps[requestIndex]?.run).toContain(
      'if [ "$RUN_ATTEMPT" -gt 1 ]; then',
    );
    expect(steps[requestIndex]?.run).toContain(
      'request_id="$RECOVERY_REQUEST_ID"',
    );
    expect(steps[requestIndex]?.run).toContain("recover_existing=true");
    expect(steps[requestIndex]?.run).toContain("recovery_only=true");
    expect(steps[liveIndex]?.env).toMatchObject({
      AGENT_IMAGE_CANARY_EXPECTED_DEPLOY_COMMIT:
        "$" + "{{ steps.deploy-pre.outputs.commit }}",
      AGENT_IMAGE_CANARY_REQUEST_ID:
        "$" + "{{ steps.request.outputs.request_id }}",
      AGENT_IMAGE_CANARY_RECOVER_EXISTING:
        "$" + "{{ steps.request.outputs.recover_existing }}",
      AGENT_IMAGE_CANARY_RECOVERY_ONLY:
        "$" + "{{ steps.request.outputs.recovery_only }}",
      ELIZACLOUD_API_KEY: "$" + "{{ secrets.ELIZACLOUD_API_KEY }}",
    });
    expect(steps[preDeployIndex]?.run).toContain(
      "git fetch --no-tags origin main",
    );
    expect(steps[preDeployIndex]?.run).toContain(
      'if [ "$GITHUB_SHA" != "$main_head" ]; then',
    );
    expect(steps[preDeployIndex]?.run).toContain(
      'if [ "$deployed_commit" != "$GITHUB_SHA" ]; then',
    );
    expect(steps[postDeployIndex]?.run).toContain(
      '[ "$deployed_commit" != "$EXPECTED_DEPLOY_COMMIT" ]',
    );
    expect(steps[postDeployIndex]?.run).toContain(
      'if [ "$deployed_commit" != "$GITHUB_SHA" ]; then',
    );
    expect(steps[postDeployIndex]?.run).toContain(
      'if [ "$(git rev-parse origin/main)" != "$GITHUB_SHA" ]; then',
    );
    expect(source).toContain(
      'git merge-base --is-ancestor "$deployed_commit" "origin/main"',
    );
    expect(source).toContain("refs/heads/main");
    expect(source).toContain(AGENT_IMAGE_CANARY_PRODUCTION_ORIGIN);
    expect(source).toContain(
      "ELIZACLOUD_API_KEY: $" + "{{ secrets.ELIZACLOUD_API_KEY }}",
    );
    expect(source).not.toContain("ELIZAOS_CLOUD_API_KEY");
    expect(source).not.toContain("pull_request:");
    expect(source).not.toContain("schedule:");
    expect(source).not.toContain("Authorization: Bearer");
    expect(source).not.toContain("/api/v1/admin/agent-image-canary/cancel");
    expect(source).toContain(
      "if main or production advanced: dispatch this workflow from current main",
    );
    expect(source).toContain(
      "recovery-only dispatches use the actor-bound GET/poll path and cannot preview or execute.",
    );
    expect(source).toContain(
      "Recovery requires one lowercase prior request UUID.",
    );
    expect(source).toContain("bun-version: \"1.3.14\"");
    expect(source).toContain("agent-image-canary-live.test.ts");
    expect(source).toContain("agent-image-canary-live.ts");
  });
});
