/**
 * ElizaSandboxService.pushClaimedWarmContainerInferenceKey (warm pool, F0).
 *
 * A warm-pool container boots under the sentinel pool org with a cloud
 * inference key scoped to THAT org. After a claim the running container must be
 * re-credentialed to the CLAIMING user's org or it replies "My Eliza Cloud key
 * isn't authorized for inference right now". This service method:
 *   1. mints a NEW inference key for the CLAIMING user's org (createForAgent
 *      revokes only the claimed row's OWN prior key name — the pool boot key
 *      lives under the deleted pool row's name and is untouchable here);
 *   2. persists it onto the row env (ELIZAOS_CLOUD_API_KEY) for restart safety;
 *   3. pushes it onto the LIVE container via its authenticated
 *      POST /api/cloud/login/persist route with forceInferenceEnabled, and
 *      verifies the echoed appliedKeyFingerprint when present;
 *   4. after a successful push, revokes the pool-org BOOT key by the
 *      warm_pool_row_id the claim carried out of its transaction.
 *
 * These pins:
 *   - the mint is scoped to the CLAIMED row's user org (never the pool org);
 *   - a defensive guard REFUSES a row still owned by the sentinel pool org;
 *   - the persist request carries the NEW key + org + forceInferenceEnabled,
 *     over the authed transport, and the SECRET NEVER appears in a log;
 *   - the row env is updated so a restart boots re-credentialed;
 *   - a matching fingerprint echo yields verified:true; a MISMATCH throws
 *     (stale key shadowing the swap) and skips the pool revoke; a legacy
 *     response without the field is pushed-but-unverified;
 *   - the pool boot key is revoked ONLY after a successful push (never on the
 *     failure branch), by pool row id, best-effort with a stable event;
 *   - a non-2xx persist response throws (bounded) so the caller can log the
 *     stable failure event; the claim itself survives (caller contract).
 * [sol-warmpool-keypush]
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const WARM_POOL_ORG_ID = "00000000-0000-4000-8000-000000077001";
const AGENT_ID = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
const USER_ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const MINTED_KEY = "eliza_mintedsecretmusntleak00000";
const POOL_BOOT_KEY = "eliza_poolorgsecretmusntleak0000";

const createForAgent = mock(
  async (_p: { organizationId: string; userId: string; agentSandboxId: string }) => ({
    apiKey: { id: "key-1", key_prefix: MINTED_KEY.slice(0, 12) },
    plainKey: MINTED_KEY,
  }),
);
const revokeForAgent = mock(async (_agentSandboxId: string) => undefined);
const update = mock(async (_id: string, _data: Record<string, unknown>) => undefined);

// Mock ONLY the api-keys service (mint + revoke boundary). The agent-sandboxes
// repository is imported for many named exports by eliza-sandbox, so instead
// of mocking the whole module we override `update` on the real singleton below.
mock.module("./api-keys", () => ({
  apiKeysService: { createForAgent, revokeForAgent },
}));

const { agentSandboxesRepository } = await import("../../db/repositories/agent-sandboxes");
(agentSandboxesRepository as unknown as { update: typeof update }).update = update;

const loggerWarn = mock((_msg: string, _meta?: Record<string, unknown>) => undefined);
const loggerInfo = mock((_msg: string, _meta?: Record<string, unknown>) => undefined);
const loggerError = mock((_msg: string, _meta?: Record<string, unknown>) => undefined);
const loggerDebug = mock((_msg: string, _meta?: Record<string, unknown>) => undefined);
mock.module("../utils/logger", () => ({
  logger: {
    warn: loggerWarn,
    info: loggerInfo,
    error: loggerError,
    debug: loggerDebug,
  },
}));

const { ElizaSandboxService } = await import("./eliza-sandbox.ts?warmkeypush");
const { warmClaimKeyFingerprint } = await import("./warm-claim-key-push");

// The fingerprint an up-to-date container echoes after applying MINTED_KEY.
const MINTED_KEY_FINGERPRINT = await warmClaimKeyFingerprint(MINTED_KEY);

type KeyPusher = {
  pushClaimedWarmContainerInferenceKey(rec: Record<string, unknown>): Promise<{
    pushed: boolean;
    verified?: boolean;
    keyPrefix?: string;
  }>;
};

const originalFetch = globalThis.fetch;
const originalWebSocketPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");

let capturedRequests: Array<{ url: string; body: string; headers: Headers }> = [];

beforeEach(() => {
  createForAgent.mockClear();
  revokeForAgent.mockReset();
  revokeForAgent.mockResolvedValue(undefined);
  update.mockClear();
  loggerWarn.mockClear();
  loggerInfo.mockClear();
  loggerError.mockClear();
  capturedRequests = [];
  // Deliberately DO NOT define WebSocketPair: we want the non-Worker runtime
  // path so fetchAgentApi targets the trusted docker-web origin (health_url)
  // rather than the Cloudflare worker agent-router (which needs routing env).
  if (originalWebSocketPair) {
    Reflect.deleteProperty(globalThis, "WebSocketPair");
  }
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    capturedRequests.push({
      url,
      body: typeof init?.body === "string" ? init.body : "",
      headers: new Headers(init?.headers),
    });
    // Default: an up-to-date container that applied the pushed key and echoes
    // its fingerprint. Legacy/mismatch shapes are overridden per test.
    return Response.json({
      ok: true,
      appliedKeyFingerprint: MINTED_KEY_FINGERPRINT,
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWebSocketPair) {
    Object.defineProperty(globalThis, "WebSocketPair", originalWebSocketPair);
  } else {
    Reflect.deleteProperty(globalThis, "WebSocketPair");
  }
});

const POOL_ROW_ID = "44444444-4444-4444-8444-444444444444";

function claimedRow() {
  return {
    id: AGENT_ID,
    organization_id: USER_ORG_ID,
    user_id: USER_ID,
    // health_url is a trusted docker-web origin, so fetchAgentApi targets it
    // directly (no worker router / base domain in this test env).
    health_url: "http://100.64.0.11:3000/api",
    bridge_url: "http://100.64.0.11:3000",
    node_id: "node-1",
    bridge_port: 21060,
    web_ui_port: 3000,
    headscale_ip: "100.64.0.11",
    sandbox_id: `agent-${AGENT_ID}`,
    // Carried out of the claim tx: the id of the DELETED pool row, whose name
    // the container's boot inference key was minted under.
    warm_pool_row_id: POOL_ROW_ID,
    environment_vars: {
      ELIZA_API_TOKEN: "agent_transport_token",
      ELIZAOS_CLOUD_API_KEY: POOL_BOOT_KEY,
    },
  };
}

function svc(): KeyPusher {
  return new ElizaSandboxService() as unknown as KeyPusher;
}

describe("pushClaimedWarmContainerInferenceKey", () => {
  test("mints against the user org, persists env, pushes forceInferenceEnabled, no secret leak", async () => {
    const result = await svc().pushClaimedWarmContainerInferenceKey(claimedRow());

    expect(result.pushed).toBe(true);
    // The container echoed the fingerprint of the minted key — process-verified.
    expect(result.verified).toBe(true);
    expect(result.keyPrefix).toBe(`${MINTED_KEY.slice(0, 12)}…`);

    // 1. Mint scoped to the CLAIMED row's user org — NEVER the pool org.
    expect(createForAgent).toHaveBeenCalledTimes(1);
    const mintArg = createForAgent.mock.calls[0]?.[0];
    expect(mintArg?.organizationId).toBe(USER_ORG_ID);
    expect(mintArg?.organizationId).not.toBe(WARM_POOL_ORG_ID);
    expect(mintArg?.userId).toBe(USER_ID);
    expect(mintArg?.agentSandboxId).toBe(AGENT_ID);

    // 2. Row env updated so a restart boots re-credentialed with the NEW key.
    expect(update).toHaveBeenCalledTimes(1);
    const [updId, updData] = update.mock.calls[0] ?? [];
    expect(updId).toBe(AGENT_ID);
    const nextEnv = (updData as { environment_vars?: Record<string, string> })?.environment_vars;
    expect(nextEnv?.ELIZAOS_CLOUD_API_KEY).toBe(MINTED_KEY);
    expect(nextEnv?.ELIZAOS_CLOUD_ENABLED).toBe("true");
    // Transport token preserved.
    expect(nextEnv?.ELIZA_API_TOKEN).toBe("agent_transport_token");

    // 3. The persist push went to the container's login/persist route with the
    //    new key + org + forceInferenceEnabled, authed by the transport token.
    expect(capturedRequests).toHaveLength(1);
    const req = capturedRequests[0];
    expect(req.url).toContain("/api/cloud/login/persist");
    const body = JSON.parse(req.body) as {
      apiKey?: string;
      organizationId?: string;
      forceInferenceEnabled?: boolean;
    };
    expect(body.apiKey).toBe(MINTED_KEY);
    expect(body.organizationId).toBe(USER_ORG_ID);
    expect(body.forceInferenceEnabled).toBe(true);
    expect(req.headers.get("authorization")).toBe("Bearer agent_transport_token");

    // 4. The pool BOOT key (named for the DELETED pool row, which the step-1
    //    mint can never reach) is revoked after the successful push — no
    //    sentinel-org credential survives a completed re-key (#17066 review).
    expect(revokeForAgent).toHaveBeenCalledTimes(1);
    expect(revokeForAgent).toHaveBeenCalledWith(POOL_ROW_ID);

    // SECRET DISCIPLINE: neither the minted key nor the pool-boot key ever
    // appears in any log line.
    const logged = [...loggerInfo.mock.calls, ...loggerWarn.mock.calls, ...loggerError.mock.calls]
      .map((c) => JSON.stringify(c))
      .join("\n");
    expect(logged).not.toContain(MINTED_KEY);
    expect(logged).not.toContain(POOL_BOOT_KEY);
  });

  test("REFUSES a row still owned by the sentinel pool org (defensive guard)", async () => {
    const poolRow = { ...claimedRow(), organization_id: WARM_POOL_ORG_ID };

    await expect(svc().pushClaimedWarmContainerInferenceKey(poolRow)).rejects.toThrow(
      /sentinel-pool-org/i,
    );

    // No key minted, no env write, no push for an unclaimed pool row.
    expect(createForAgent).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(capturedRequests).toHaveLength(0);
  });

  test("a non-2xx persist response throws a bounded error (caller logs the failure)", async () => {
    globalThis.fetch = mock(
      async () => new Response("upstream boom", { status: 503 }),
    ) as unknown as typeof fetch;

    await expect(svc().pushClaimedWarmContainerInferenceKey(claimedRow())).rejects.toThrow(
      /Warm-claim key push failed: HTTP 503/,
    );

    // The key was still minted + env persisted (idempotent on retry / restart).
    expect(createForAgent).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    // The pool boot key is deliberately NOT revoked on the push-failure
    // branch — the container may still be signing with it (e.g. the gateway
    // relay); it dies with the next restart's re-credential instead.
    expect(revokeForAgent).not.toHaveBeenCalled();
  });

  test("a fingerprint MISMATCH throws (stale key shadowing the swap) and skips the pool revoke", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ ok: true, appliedKeyFingerprint: "deadbeefdeadbeef" }),
    ) as unknown as typeof fetch;

    await expect(svc().pushClaimedWarmContainerInferenceKey(claimedRow())).rejects.toThrow(
      /fingerprint mismatch/i,
    );

    // The swap did not verifiably take: leave the pool boot key alone so the
    // container is never stripped of the only credential it may still hold.
    expect(revokeForAgent).not.toHaveBeenCalled();
  });

  test("a legacy container response without a fingerprint is pushed-but-unverified; revoke still runs", async () => {
    globalThis.fetch = mock(async () => Response.json({ ok: true })) as unknown as typeof fetch;

    const result = await svc().pushClaimedWarmContainerInferenceKey(claimedRow());

    expect(result.pushed).toBe(true);
    expect(result.verified).toBe(false);
    // Transport accepted the push (HTTP 200): the boot key revoke proceeds.
    expect(revokeForAgent).toHaveBeenCalledTimes(1);
    expect(revokeForAgent).toHaveBeenCalledWith(POOL_ROW_ID);
  });

  test("a pool-key revoke failure is best-effort: push still reports success with the stable event", async () => {
    revokeForAgent.mockRejectedValueOnce(new Error("db down"));

    const result = await svc().pushClaimedWarmContainerInferenceKey(claimedRow());

    expect(result.pushed).toBe(true);
    expect(result.verified).toBe(true);
    const revokeEvents = loggerWarn.mock.calls.filter(
      (c) =>
        (c[1] as Record<string, unknown> | undefined)?.event === "warm_pool.pool_key_revoke_failed",
    );
    expect(revokeEvents).toHaveLength(1);
    expect((revokeEvents[0]?.[1] as Record<string, unknown>)?.poolRowId).toBe(POOL_ROW_ID);
  });

  test("a claimed row without warm_pool_row_id skips the revoke (nothing to revoke by)", async () => {
    const rec = claimedRow() as Record<string, unknown>;
    delete rec.warm_pool_row_id;

    const result = await svc().pushClaimedWarmContainerInferenceKey(rec);

    expect(result.pushed).toBe(true);
    expect(revokeForAgent).not.toHaveBeenCalled();
  });
});
