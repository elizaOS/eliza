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
 *   3. pushes it onto the live container and durably records fingerprint
 *      attestation;
 *   4. revokes the pool-org boot key by source row id and only then finalizes
 *      the claimed row as ready.
 *
 * These pins:
 *   - the mint is scoped to the CLAIMED row's user org (never the pool org);
 *   - a defensive guard REFUSES a row still owned by the sentinel pool org;
 *   - the persist request carries the NEW key + org + forceInferenceEnabled,
 *     over the authed transport, and the SECRET NEVER appears in a log;
 *   - the row env is updated so a restart boots re-credentialed;
 *   - a matching fingerprint is mandatory; mismatch or absence throws;
 *   - the pool boot key remains active until live adoption is durably attested,
 *     then is revoked before the row becomes ready;
 *   - a non-2xx persist response throws (bounded) so the caller can log the
 *     stable failure event; the claim itself survives (caller contract).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const WARM_POOL_ORG_ID = "00000000-0000-4000-8000-000000077001";
const AGENT_ID = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
const USER_ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
// Synthetic fixtures assembled by concatenation so no `eliza_`-prefixed
// token-shaped literal exists for secret scanners to flag.
const MINTED_KEY = "eliza_" + "mintedsecretmusntleak00000";
const REMINTED_KEY = "eliza_" + "remintedsecretmusntleak000";
const POOL_BOOT_KEY = "eliza_" + "poolorgsecretmusntleak0000";

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

type KeyPusher = {
  pushClaimedWarmContainerInferenceKey(rec: Record<string, unknown>): Promise<{
    pushed: boolean;
    keyPrefix?: string;
  }>;
  recoverPendingWarmClaimInferenceKey(
    agentId: string,
    organizationId: string,
  ): Promise<{ pushed: boolean; keyPrefix?: string }>;
};

const originalFetch = globalThis.fetch;
const originalWebSocketPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");

let capturedRequests: Array<{ url: string; body: string; headers: Headers }> = [];
let databaseRow: ReturnType<typeof buildInitialDbRow>;
let rearmFingerprint: string | null = null;
let remintedKeyOverride: string | null = null;

const transaction = mock(async (callback: (tx: { execute: () => Promise<unknown> }) => unknown) => {
  let executeCount = 0;
  return await callback({
    execute: async () => {
      executeCount += 1;
      if (executeCount === 1) return { rows: [] };
      if (executeCount === 2) return { rows: [databaseRow] };

      if (
        databaseRow.warm_claim_credential_state === "pending" &&
        databaseRow.warm_claim_key_fingerprint === null
      ) {
        const persistedKey = remintedKeyOverride ?? MINTED_KEY;
        const persistedFingerprint = rearmFingerprint ?? MINTED_KEY_FINGERPRINT;
        databaseRow = {
          ...databaseRow,
          environment_revision: databaseRow.environment_revision + 1,
          warm_claim_key_fingerprint: persistedFingerprint,
          environment_vars: {
            ...databaseRow.environment_vars,
            ELIZAOS_CLOUD_API_KEY: persistedKey,
            ELIZAOS_CLOUD_ENABLED: "true",
          },
        };
        await update(AGENT_ID, {
          environment_vars: databaseRow.environment_vars,
          warm_claim_key_fingerprint: persistedFingerprint,
        });
        rearmFingerprint = null;
        remintedKeyOverride = null;
        return { rows: [databaseRow] };
      }

      if (rearmFingerprint) {
        databaseRow = {
          ...databaseRow,
          warm_claim_credential_state: "pending",
          warm_claim_key_fingerprint: null,
          warm_claim_attested_at: null,
          warm_claim_attested_environment_revision: null,
        };
        await update(AGENT_ID, {
          warm_claim_credential_state: "pending",
          warm_claim_key_fingerprint: null,
          warm_claim_attested_at: null,
          warm_claim_attested_environment_revision: null,
        });
        return { rows: [databaseRow] };
      }

      if (databaseRow.warm_claim_credential_state === "pending") {
        databaseRow = {
          ...databaseRow,
          warm_claim_credential_state: "attested",
          warm_claim_attested_at: new Date("2026-07-23T00:00:01.000Z"),
          warm_claim_attested_environment_revision: databaseRow.environment_revision,
        };
        await update(AGENT_ID, {
          warm_claim_credential_state: "attested",
          warm_claim_attested_at: databaseRow.warm_claim_attested_at,
          warm_claim_attested_environment_revision: databaseRow.environment_revision,
        });
        return { rows: [{ environment_revision: databaseRow.environment_revision }] };
      }

      databaseRow = {
        ...databaseRow,
        status: "running",
        warm_claim_credential_state: "ready",
        warm_claim_source_pool_id: null,
      };
      await update(AGENT_ID, {
        status: "running",
        warm_claim_credential_state: "ready",
        warm_claim_source_pool_id: null,
      });
      return { rows: [{ id: AGENT_ID }] };
    },
  });
});
mock.module("../../db/helpers", () => ({
  dbWrite: { transaction },
  dbRead: {},
}));

const { ElizaSandboxService } = await import("./eliza-sandbox.ts?warmkeypush");
const { warmClaimKeyFingerprint } = await import("./warm-claim-key-push");

// The fingerprint an up-to-date container echoes after applying MINTED_KEY.
const MINTED_KEY_FINGERPRINT = await warmClaimKeyFingerprint(MINTED_KEY);

beforeEach(() => {
  createForAgent.mockReset();
  createForAgent.mockResolvedValue({
    apiKey: { id: "key-1", key_prefix: MINTED_KEY.slice(0, 12) },
    plainKey: MINTED_KEY,
  });
  revokeForAgent.mockReset();
  revokeForAgent.mockResolvedValue(undefined);
  update.mockClear();
  transaction.mockClear();
  databaseRow = buildInitialDbRow();
  rearmFingerprint = null;
  remintedKeyOverride = null;
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

function buildInitialDbRow() {
  return {
    ...claimedRow(),
    claimed_at: new Date("2026-07-23T00:00:00.000Z"),
    status: "provisioning",
    environment_revision: 1,
    warm_claim_credential_state: "pending" as "pending" | "attested" | "ready",
    warm_claim_source_pool_id: POOL_ROW_ID as string | null,
    warm_claim_key_fingerprint: null as string | null,
    warm_claim_attested_at: null as Date | null,
    warm_claim_attested_environment_revision: null as number | null,
  };
}

function svc(): KeyPusher {
  return new ElizaSandboxService() as unknown as KeyPusher;
}

describe("pushClaimedWarmContainerInferenceKey", () => {
  test("mints against the user org, persists env, pushes forceInferenceEnabled, no secret leak", async () => {
    const result = await svc().pushClaimedWarmContainerInferenceKey(claimedRow());

    expect(result.pushed).toBe(true);
    expect(result.keyPrefix).toBe(`${MINTED_KEY.slice(0, 12)}…`);

    // 1. Mint scoped to the CLAIMED row's user org — NEVER the pool org.
    expect(createForAgent).toHaveBeenCalledTimes(1);
    const mintArg = createForAgent.mock.calls[0]?.[0];
    expect(mintArg?.organizationId).toBe(USER_ORG_ID);
    expect(mintArg?.organizationId).not.toBe(WARM_POOL_ORG_ID);
    expect(mintArg?.userId).toBe(USER_ID);
    expect(mintArg?.agentSandboxId).toBe(AGENT_ID);

    // 2. Row env updated so a restart boots re-credentialed with the NEW key.
    expect(update).toHaveBeenCalledTimes(3);
    const [updId, updData] = update.mock.calls[0] ?? [];
    expect(updId).toBe(AGENT_ID);
    const nextEnv = (updData as { environment_vars?: Record<string, string> })?.environment_vars;
    expect(nextEnv?.ELIZAOS_CLOUD_API_KEY).toBe(MINTED_KEY);
    expect(nextEnv?.ELIZAOS_CLOUD_ENABLED).toBe("true");
    // Transport token preserved.
    expect(nextEnv?.ELIZA_API_TOKEN).toBe("agent_transport_token");
    expect(update.mock.calls[1]?.[1]).toMatchObject({
      warm_claim_credential_state: "attested",
    });
    expect(update.mock.calls[2]?.[1]).toMatchObject({
      warm_claim_credential_state: "ready",
    });

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

  test("keeps the durable claim fence pending until live fingerprint attestation", async () => {
    const fetchEntered = Promise.withResolvers<void>();
    const releaseFetch = Promise.withResolvers<void>();
    globalThis.fetch = mock(async () => {
      fetchEntered.resolve();
      await releaseFetch.promise;
      return Response.json({
        ok: true,
        appliedKeyFingerprint: MINTED_KEY_FINGERPRINT,
      });
    }) as unknown as typeof fetch;

    const inFlight = svc().pushClaimedWarmContainerInferenceKey(claimedRow());
    await fetchEntered.promise;

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[1]).toMatchObject({
      warm_claim_key_fingerprint: MINTED_KEY_FINGERPRINT,
    });

    releaseFetch.resolve();
    await expect(inFlight).resolves.toMatchObject({ pushed: true });
    expect(update).toHaveBeenCalledTimes(3);
    expect(update.mock.calls[1]?.[1]).toMatchObject({
      warm_claim_credential_state: "attested",
    });
    expect(update.mock.calls[2]?.[1]).toMatchObject({
      warm_claim_credential_state: "ready",
    });
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

    // The key was still minted + env persisted (idempotent on retry / restart),
    // but the source credential remains active until the live target attests.
    expect(createForAgent).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(revokeForAgent).not.toHaveBeenCalled();
  });

  test("a fingerprint mismatch throws without revoking the still-active pool credential", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ ok: true, appliedKeyFingerprint: "deadbeefdeadbeef" }),
    ) as unknown as typeof fetch;

    await expect(svc().pushClaimedWarmContainerInferenceKey(claimedRow())).rejects.toThrow(
      /not attested/i,
    );
    expect(revokeForAgent).not.toHaveBeenCalled();
  });

  test("a legacy response without a fingerprint enters restart recovery", async () => {
    globalThis.fetch = mock(async () => Response.json({ ok: true })) as unknown as typeof fetch;

    await expect(svc().pushClaimedWarmContainerInferenceKey(claimedRow())).rejects.toThrow(
      /not attested/i,
    );
    expect(revokeForAgent).not.toHaveBeenCalled();
  });

  test("a pool-key revoke failure remains attested and restart recovery finalizes idempotently", async () => {
    revokeForAgent.mockRejectedValueOnce(new Error("db down"));

    await expect(svc().pushClaimedWarmContainerInferenceKey(claimedRow())).rejects.toThrow(
      "db down",
    );
    expect(databaseRow).toMatchObject({
      status: "provisioning",
      warm_claim_credential_state: "attested",
      warm_claim_source_pool_id: POOL_ROW_ID,
    });
    expect(capturedRequests).toHaveLength(1);

    await expect(svc().recoverPendingWarmClaimInferenceKey(AGENT_ID, USER_ORG_ID)).resolves.toEqual(
      { pushed: false },
    );
    expect(revokeForAgent).toHaveBeenCalledTimes(2);
    expect(capturedRequests).toHaveLength(1);
    expect(databaseRow).toMatchObject({
      status: "running",
      warm_claim_credential_state: "ready",
      warm_claim_source_pool_id: null,
    });
  });

  test("an environment CAS loser re-arms attestation and recovers the current persisted key", async () => {
    const rotatedKey = "eliza_" + "rotatedtargetsecretmusntleak";
    const remintedFingerprint = await warmClaimKeyFingerprint(REMINTED_KEY);
    createForAgent
      .mockResolvedValueOnce({
        apiKey: { id: "key-1", key_prefix: MINTED_KEY.slice(0, 12) },
        plainKey: MINTED_KEY,
      })
      .mockResolvedValueOnce({
        apiKey: { id: "key-2", key_prefix: REMINTED_KEY.slice(0, 12) },
        plainKey: REMINTED_KEY,
      });
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = typeof init?.body === "string" ? init.body : "";
      capturedRequests.push({ url, body, headers: new Headers(init?.headers) });
      const parsed = JSON.parse(body) as { apiKey: string };
      return Response.json({
        ok: true,
        appliedKeyFingerprint: await warmClaimKeyFingerprint(parsed.apiKey),
      });
    }) as unknown as typeof fetch;
    revokeForAgent.mockImplementationOnce(async () => {
      databaseRow = {
        ...databaseRow,
        environment_revision: databaseRow.environment_revision + 1,
        environment_vars: {
          ...databaseRow.environment_vars,
          ELIZAOS_CLOUD_API_KEY: rotatedKey,
          UNRELATED_FLAG: "preserved",
        },
      };
      rearmFingerprint = remintedFingerprint;
      remintedKeyOverride = REMINTED_KEY;
    });

    await expect(svc().pushClaimedWarmContainerInferenceKey(claimedRow())).rejects.toThrow(
      /finalization lost its state CAS/i,
    );
    expect(databaseRow).toMatchObject({
      status: "provisioning",
      warm_claim_credential_state: "attested",
      warm_claim_key_fingerprint: MINTED_KEY_FINGERPRINT,
    });

    await expect(
      svc().recoverPendingWarmClaimInferenceKey(AGENT_ID, USER_ORG_ID),
    ).resolves.toMatchObject({ pushed: true });
    expect(createForAgent).toHaveBeenCalledTimes(2);
    expect(capturedRequests).toHaveLength(2);
    expect(revokeForAgent).toHaveBeenCalledTimes(2);
    expect(databaseRow).toMatchObject({
      status: "running",
      warm_claim_credential_state: "ready",
      warm_claim_key_fingerprint: remintedFingerprint,
      warm_claim_source_pool_id: null,
      environment_vars: {
        ELIZAOS_CLOUD_API_KEY: REMINTED_KEY,
        UNRELATED_FLAG: "preserved",
      },
    });
  });

  test("a pending fingerprint mismatch remints instead of adopting a stale environment key", async () => {
    const remintedFingerprint = await warmClaimKeyFingerprint(REMINTED_KEY);
    const initial = buildInitialDbRow();
    databaseRow = {
      ...initial,
      environment_revision: 4,
      warm_claim_key_fingerprint: MINTED_KEY_FINGERPRINT,
      environment_vars: {
        ...initial.environment_vars,
        ELIZAOS_CLOUD_API_KEY: POOL_BOOT_KEY,
        UNRELATED_FLAG: "preserved",
      },
    };
    rearmFingerprint = remintedFingerprint;
    remintedKeyOverride = REMINTED_KEY;
    createForAgent.mockResolvedValue({
      apiKey: { id: "key-2", key_prefix: REMINTED_KEY.slice(0, 12) },
      plainKey: REMINTED_KEY,
    });
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      capturedRequests.push({
        url: typeof input === "string" ? input : input.toString(),
        body,
        headers: new Headers(init?.headers),
      });
      const parsed = JSON.parse(body) as { apiKey: string };
      return Response.json({
        ok: true,
        appliedKeyFingerprint: await warmClaimKeyFingerprint(parsed.apiKey),
      });
    }) as unknown as typeof fetch;

    await expect(
      svc().recoverPendingWarmClaimInferenceKey(AGENT_ID, USER_ORG_ID),
    ).resolves.toMatchObject({ pushed: true });

    expect(createForAgent).toHaveBeenCalledTimes(1);
    expect(capturedRequests).toHaveLength(1);
    expect(JSON.parse(capturedRequests[0]!.body)).toMatchObject({
      apiKey: REMINTED_KEY,
      organizationId: USER_ORG_ID,
    });
    expect(databaseRow).toMatchObject({
      status: "running",
      warm_claim_credential_state: "ready",
      warm_claim_key_fingerprint: remintedFingerprint,
      warm_claim_source_pool_id: null,
      environment_vars: {
        ELIZAOS_CLOUD_API_KEY: REMINTED_KEY,
        UNRELATED_FLAG: "preserved",
      },
    });
  });

  test("requires the source pool row id", async () => {
    const rec = claimedRow() as Record<string, unknown>;
    delete rec.warm_pool_row_id;

    await expect(svc().pushClaimedWarmContainerInferenceKey(rec)).rejects.toThrow(/agent-sandbox/i);
  });

  test("a blank minted key fails closed instead of reporting an unpushed success", async () => {
    createForAgent.mockResolvedValueOnce({
      apiKey: { id: "key-1", key_prefix: "" },
      plainKey: "",
    });

    await expect(svc().pushClaimedWarmContainerInferenceKey(claimedRow())).rejects.toThrow(
      /target credential is unavailable/i,
    );
    // The broken mint never reaches the live container or the pool revoke.
    expect(capturedRequests).toHaveLength(0);
    expect(revokeForAgent).not.toHaveBeenCalled();
  });
});
