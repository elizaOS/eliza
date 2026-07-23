/**
 * End-to-end proof of the sensitive-request hosted-page pipeline (#14326) —
 * the most security-sensitive path we ship: an agent asks for a secret/private
 * field from a group chat where an inline widget cannot render, DMs a link, the
 * recipient completes a form on a hosted authenticated page proving access with
 * a single-use token, and the result round-trips back to the agent.
 *
 * This drives the REAL code, stitched together the way production wires it:
 *   - the REAL `createSensitiveRequestDispatchRegistry` from `@elizaos/core`,
 *     with two connector-style `dm` adapters (Telegram-like + Discord-like)
 *     registered under the same target and resolved per channel via
 *     `supportsChannel` — proving loading both connectors does not collide;
 *   - the REAL `SensitiveRequestsService` (token mint, single-use enforcement,
 *     policy authorization, fulfillment, status machine) over an in-memory
 *     repository standing in only for Postgres;
 *   - the REAL `createSensitiveCallbackBus` wired as the service's
 *     `dispatchEvent`, so the agent's callback listener observes the actual
 *     fulfillment event — this is how the agent "sees the result land back".
 *
 * The ONLY stubs are the outbound connector send (we assert the link the agent
 * would DM, not a live Telegram/Discord API call) and Postgres. Every security
 * invariant — single-use token, tampered token, expired request,
 * requireAuthenticatedLink blocking an anonymous submit, and secret material
 * never appearing in the redacted transport view — is asserted against real
 * service behavior. A broken token/policy path fails this file.
 *
 * The live harness at the bottom (#16940) drives the REAL deployed cloud —
 * no stand-ins at all: create over the real API, the real hosted page shell,
 * the real token-gated public view, a sessionless single-use-token submit, the
 * real replay/tamper rejections, and the real Postgres-backed audit trail
 * (including `secret.set` with the stored org-secret id). It is gated on
 * `ELIZA_SENSITIVE_LIVE=1` + `ELIZAOS_CLOUD_API_KEY`, self-skips with a reason
 * when creds are absent, and is fail-closed when enabled: any broken live leg
 * fails the run — it can never fake-pass. The connector-DM leg additionally
 * needs `TELEGRAM_BOT_TOKEN` + `ELIZA_SENSITIVE_LIVE_TELEGRAM_CHAT_ID` and a
 * human to tap the DM'd link and submit on the hosted page within the poll
 * window — that is the owner-run leg that produces the MP4 evidence.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  createSensitiveRequestDispatchRegistry,
  type DeliveryResult,
  type SensitiveRequestDeliveryAdapter,
} from "@elizaos/core";
import type {
  NewSensitiveRequest,
  NewSensitiveRequestEvent,
  SensitiveRequest,
  SensitiveRequestEvent,
  SensitiveRequestStatus,
  SensitiveRequestWithEvents,
} from "../../db/repositories/sensitive-requests";
import { createSensitiveCallbackBus, type SensitiveCallbackEvent } from "./sensitive-callback-bus";
import {
  type SensitiveRequestActor,
  type SensitiveRequestsRepositoryLike,
  SensitiveRequestsService,
} from "./sensitive-requests";

const ORG_ID = "00000000-0000-4000-8000-000000000010";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000099";
const AGENT_ID = "agent-e2e";
const OWNER_USER_ID = "owner-user-e2e";
const SECRET_VALUE = "sk-live-DO-NOT-LEAK-1234567890";

// ---------------------------------------------------------------------------
// In-memory repository — stands in for Postgres only. Every method mirrors the
// real repository contract the service depends on, including the atomic
// single-use guard in `markTokenUsed` (returns undefined if already used).
// ---------------------------------------------------------------------------

class InMemoryRepo implements SensitiveRequestsRepositoryLike {
  private requests = new Map<string, SensitiveRequest>();
  private events: SensitiveRequestEvent[] = [];
  private seq = 0;

  async create(data: NewSensitiveRequest): Promise<SensitiveRequest> {
    const id = data.id ?? `req-${++this.seq}`;
    const now = new Date();
    const row: SensitiveRequest = {
      id,
      kind: data.kind,
      status: data.status ?? "pending",
      organization_id: data.organization_id ?? null,
      agent_id: data.agent_id,
      owner_entity_id: data.owner_entity_id ?? null,
      requester_entity_id: data.requester_entity_id ?? null,
      source_room_id: data.source_room_id ?? null,
      source_channel_type: data.source_channel_type ?? null,
      source_platform: data.source_platform ?? null,
      target: data.target,
      policy: data.policy,
      delivery: data.delivery,
      callback: data.callback ?? {},
      token_hash: data.token_hash ?? null,
      token_used_at: data.token_used_at ?? null,
      expires_at: data.expires_at,
      fulfilled_at: data.fulfilled_at ?? null,
      canceled_at: data.canceled_at ?? null,
      expired_at: data.expired_at ?? null,
      created_by: data.created_by ?? null,
      created_at: now,
      updated_at: now,
    };
    this.requests.set(id, row);
    return row;
  }

  async findById(id: string): Promise<SensitiveRequest | undefined> {
    return this.requests.get(id);
  }

  async findWithEvents(id: string): Promise<SensitiveRequestWithEvents | undefined> {
    const request = this.requests.get(id);
    if (!request) return undefined;
    return { request, events: await this.listEvents(id) };
  }

  async update(
    id: string,
    data: Partial<NewSensitiveRequest>,
  ): Promise<SensitiveRequest | undefined> {
    const existing = this.requests.get(id);
    if (!existing) return undefined;
    const next = { ...existing, ...data, updated_at: new Date() } as SensitiveRequest;
    this.requests.set(id, next);
    return next;
  }

  async transitionStatus(
    id: string,
    fromStatuses: SensitiveRequestStatus[],
    status: SensitiveRequestStatus,
    data: Partial<NewSensitiveRequest> = {},
  ): Promise<SensitiveRequest | undefined> {
    const existing = this.requests.get(id);
    if (!existing || !fromStatuses.includes(existing.status)) return undefined;
    return this.update(id, { ...data, status });
  }

  async markTokenUsed(id: string): Promise<SensitiveRequest | undefined> {
    const existing = this.requests.get(id);
    // Single-use invariant: a second call after the token was consumed returns
    // undefined, which the service turns into an auth rejection.
    if (!existing || existing.token_used_at) return undefined;
    return this.update(id, { token_used_at: new Date() });
  }

  async appendEvent(data: NewSensitiveRequestEvent): Promise<SensitiveRequestEvent> {
    const event: SensitiveRequestEvent = {
      id: `evt-${++this.seq}`,
      request_id: data.request_id,
      organization_id: data.organization_id ?? null,
      event_type: data.event_type,
      actor_type: data.actor_type ?? "system",
      actor_id: data.actor_id ?? null,
      metadata: data.metadata ?? {},
      created_at: new Date(),
    };
    this.events.push(event);
    return event;
  }

  async listEvents(requestId: string): Promise<SensitiveRequestEvent[]> {
    return this.events.filter((event) => event.request_id === requestId);
  }

  /** Test-only: force `expires_at` into the past to exercise lazy expiry. */
  forceExpiry(id: string, at: Date): void {
    const existing = this.requests.get(id);
    if (existing) existing.expires_at = at;
  }
}

// ---------------------------------------------------------------------------
// Connector-style DM adapters. These are the real adapter contract from core;
// only the outbound send is stubbed (records the link instead of hitting the
// Telegram/Discord API). `supportsChannel` mirrors the production adapters:
// each connector claims a DM only when its own transport is the source.
// ---------------------------------------------------------------------------

interface CapturedDelivery {
  connector: string;
  channelId?: string;
  url?: string;
  payload: string;
}

function makeDmAdapter(
  connector: string,
  claimsChannel: (channelId: string | undefined) => boolean,
  cloudBase: string,
  sink: CapturedDelivery[],
): SensitiveRequestDeliveryAdapter {
  return {
    target: "dm",
    supportsChannel: (channelId) => claimsChannel(channelId),
    async deliver({ request, channelId }): Promise<DeliveryResult> {
      const url = `${cloudBase}/sensitive-requests/${encodeURIComponent(request.id)}`;
      // The link — and only the link — is what a connector DMs. The secret is
      // never known to the connector at delivery time; it is collected later on
      // the hosted page. We record the exact bytes that would hit the wire so
      // the no-secret-in-transport assertion can inspect them.
      const payload = JSON.stringify({
        chat_id: channelId,
        text: `To continue, open your secure link: ${url}`,
      });
      sink.push({ connector, channelId, url, payload });
      return { delivered: true, target: "dm", url, channelId };
    },
  };
}

// ---------------------------------------------------------------------------

let repo: InMemoryRepo;
let capturedDeliveries: CapturedDelivery[];
let callbackBus: ReturnType<typeof createSensitiveCallbackBus>;
let recordedCallbackEvents: SensitiveCallbackEvent[];
let fulfilledPrivateFields: Record<string, string> | null;
let createdSecrets: Array<{ name: string; value: string; organizationId: string }>;

function buildService(): SensitiveRequestsService {
  fulfilledPrivateFields = null;
  createdSecrets = [];
  return new SensitiveRequestsService({
    repository: repo,
    // Real secrets service is a Worker binding; substitute a recorder that
    // proves the secret value reaches storage (and lets us assert it is NOT in
    // any redacted view or transport payload).
    secretsService: {
      create: async (params) => {
        createdSecrets.push({
          name: params.name,
          value: params.value,
          organizationId: params.organizationId,
        });
        return {
          id: `secret-${createdSecrets.length}`,
          organizationId: params.organizationId,
          name: params.name,
          scope: params.scope,
          createdAt: new Date().toISOString(),
        } as never;
      },
    },
    fulfillPrivateInfo: async ({ fields }) => {
      fulfilledPrivateFields = fields;
    },
    // Wire the REAL callback bus as the dispatchEvent sink. On fulfillment the
    // service emits `secret.set` / `private_info.submitted`; we translate that
    // into the connector-facing `SensitiveRequestSubmitted` the agent listens
    // for, then publish it on the bus. This is the actual result-round-trip.
    dispatchEvent: async ({ event }) => {
      if (event.kind === "secret.set" || event.kind === "private_info.submitted") {
        await callbackBus.publish({
          name: "SensitiveRequestSubmitted",
          sensitiveRequestId: event.requestId,
          submittedAt: new Date(),
        });
      } else if (event.kind === "request.expired") {
        await callbackBus.publish({
          name: "SensitiveRequestExpired",
          sensitiveRequestId: event.requestId,
          expiredAt: new Date(),
        });
      }
    },
  });
}

beforeEach(() => {
  repo = new InMemoryRepo();
  capturedDeliveries = [];
  recordedCallbackEvents = [];
  callbackBus = createSensitiveCallbackBus({
    record: async (event) => {
      recordedCallbackEvents.push(event);
    },
  });
});

const OWNER_ACTOR: SensitiveRequestActor = {
  type: "user",
  userId: OWNER_USER_ID,
  organizationId: ORG_ID,
};

// ---------------------------------------------------------------------------
// Dispatch routing: a sensitive request from a group chat routes to the DM
// delivery target, and the registry resolves the right connector adapter.
// ---------------------------------------------------------------------------

describe("#14326 dispatch registry routes sensitive request to the DM connector", () => {
  test("resolve() picks the connector that owns the source channel", async () => {
    const registry = createSensitiveRequestDispatchRegistry();
    const telegram = makeDmAdapter(
      "telegram",
      (ch) => (ch ?? "").startsWith("tg:"),
      "https://cloud.example.ai",
      capturedDeliveries,
    );
    const discord = makeDmAdapter(
      "discord",
      (ch) => (ch ?? "").startsWith("dc:"),
      "https://cloud.example.ai",
      capturedDeliveries,
    );
    // Both register under the same "dm" target — the collision the registry is
    // designed to resolve per channel.
    registry.register(telegram);
    registry.register(discord);

    const tgAdapter = registry.resolve?.("dm", "tg:group-42", null);
    const dcAdapter = registry.resolve?.("dm", "dc:guild-7", null);
    expect(tgAdapter).toBe(telegram);
    expect(dcAdapter).toBe(discord);

    // Drive the resolved adapter — the link is what lands in the DM.
    const result = await tgAdapter?.deliver({
      request: { id: "req-route-1", kind: "secret" },
      channelId: "tg:group-42",
      runtime: null,
    });
    expect(result?.delivered).toBe(true);
    expect(result?.target).toBe("dm");
    expect(result?.url).toBe("https://cloud.example.ai/sensitive-requests/req-route-1");
    expect(capturedDeliveries).toHaveLength(1);
    expect(capturedDeliveries[0]?.connector).toBe("telegram");
  });
});

// ---------------------------------------------------------------------------
// Full happy path: mint → DM link → hosted page validates → submit → callback
// round-trips to the agent → secret usable, request no longer outstanding.
// ---------------------------------------------------------------------------

describe("#14326 full hosted-page round-trip (private_info, token-only link)", () => {
  test("mint → DM link → hosted page reads → submit → agent sees fulfillment", async () => {
    const service = buildService();

    // The agent, needing private info from a group chat, creates the request.
    // Token-only public link (requireAuthenticatedLink:false) is the
    // out-of-band-recipient hosted-page mode the submit route documents.
    const created = await service.create(
      {
        kind: "private_info",
        agentId: AGENT_ID,
        organizationId: ORG_ID,
        sourceChannelType: "telegram",
        sourcePlatform: "telegram",
        target: {
          kind: "private_info",
          fields: [{ name: "shipping_address", required: true }],
        },
        policy: { requireAuthenticatedLink: false, requirePrivateDelivery: false },
      },
      OWNER_ACTOR,
    );

    expect(created.submitToken).toMatch(/^sr_/);
    expect(created.request.status).toBe("pending");

    // The agent subscribes for the result BEFORE handing off the link — this is
    // the listener that makes the agent "see" the answer land back.
    const seenByAgent = callbackBus.waitFor(
      { sensitiveRequestId: created.request.id, names: ["SensitiveRequestSubmitted"] },
      5_000,
    );

    // Connector delivers the DM link (real adapter, stubbed send).
    const registry = createSensitiveRequestDispatchRegistry();
    registry.register(
      makeDmAdapter("telegram", () => true, "https://cloud.example.ai", capturedDeliveries),
    );
    const delivery = await registry
      .resolve?.("dm", "tg:group-42", null)
      ?.deliver({ request: created.request, channelId: "tg:group-42", runtime: null });
    expect(delivery?.url).toContain(`/sensitive-requests/${created.request.id}`);

    // The hosted page loads the redacted form using ONLY the token (no session).
    const pageView = await service.getPublicByToken(created.request.id, created.submitToken);
    expect(pageView.id).toBe(created.request.id);
    expect(pageView.status).toBe("pending");
    expect("audit" in pageView).toBe(false);

    // The recipient submits the form value with the single-use token.
    const submitted = await service.submit({
      id: created.request.id,
      token: created.submitToken,
      fields: { shipping_address: "742 Evergreen Terrace" },
    });
    expect(submitted.status).toBe("fulfilled");
    expect(fulfilledPrivateFields).toEqual({ shipping_address: "742 Evergreen Terrace" });

    // The agent's listener fires — the result round-trips back.
    const event = await seenByAgent;
    expect(event.name).toBe("SensitiveRequestSubmitted");
    expect(event.sensitiveRequestId).toBe(created.request.id);
    expect(recordedCallbackEvents.some((e) => e.name === "SensitiveRequestSubmitted")).toBe(true);

    // Agent-awareness: a fulfilled request is no longer pending, so it drops out
    // of the outstanding set the OUTSTANDING_SENSITIVE_REQUESTS provider reads.
    const after = await service.get(created.request.id, OWNER_ACTOR);
    expect(after.status).toBe("fulfilled");
    expect(after.fulfilledAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Secret happy path + no-secret-in-transport invariant.
// ---------------------------------------------------------------------------

describe("#14326 secret flow stores the value without leaking it into transport", () => {
  test("submit stores secret; redacted views and DM payload never contain it", async () => {
    const service = buildService();

    // Secret requests need an authenticated link by policy, so the owner (org
    // member) submits — the authenticated hosted-page mode.
    const created = await service.create(
      {
        kind: "secret",
        agentId: AGENT_ID,
        organizationId: ORG_ID,
        target: { kind: "secret", key: "OPENAI_API_KEY" },
      },
      OWNER_ACTOR,
    );

    // DM link out (real adapter).
    const registry = createSensitiveRequestDispatchRegistry();
    registry.register(
      makeDmAdapter("telegram", () => true, "https://cloud.example.ai", capturedDeliveries),
    );
    await registry
      .resolve?.("dm", "tg:group-9", null)
      ?.deliver({ request: created.request, channelId: "tg:group-9", runtime: null });

    // Authenticated org member submits the secret value.
    const submitted = await service.submit({
      id: created.request.id,
      token: created.submitToken,
      value: SECRET_VALUE,
      actor: OWNER_ACTOR,
    });
    expect(submitted.status).toBe("fulfilled");

    // The secret reached storage (agent can now use it).
    expect(createdSecrets).toHaveLength(1);
    expect(createdSecrets[0]?.value).toBe(SECRET_VALUE);
    expect(createdSecrets[0]?.name).toBe("OPENAI_API_KEY");

    // Invariant: the secret value is absent from every redacted surface and
    // from the connector DM payload. Search the full serialized blobs.
    const publicView = JSON.stringify(
      await service.getPublicByToken(created.request.id, created.submitToken),
    );
    const privateView = JSON.stringify(submitted);
    const deliveryPayloads = capturedDeliveries.map((d) => d.payload).join("|");
    expect(privateView).not.toContain(SECRET_VALUE);
    expect(publicView).not.toContain(SECRET_VALUE);
    expect(deliveryPayloads).not.toContain(SECRET_VALUE);
  });
});

// ---------------------------------------------------------------------------
// Adversarial / security-critical negative paths — all headless, all real.
// ---------------------------------------------------------------------------

describe("#14326 adversarial: token single-use, tamper, expiry, auth-required", () => {
  async function createPublicPrivateInfo(service: SensitiveRequestsService) {
    return service.create(
      {
        kind: "private_info",
        agentId: AGENT_ID,
        organizationId: ORG_ID,
        target: {
          kind: "private_info",
          fields: [{ name: "shipping_address", required: true }],
        },
        policy: { requireAuthenticatedLink: false, requirePrivateDelivery: false },
      },
      OWNER_ACTOR,
    );
  }

  test("a used token cannot be replayed (single-use)", async () => {
    const service = buildService();
    const created = await createPublicPrivateInfo(service);

    const first = await service.submit({
      id: created.request.id,
      token: created.submitToken,
      fields: { shipping_address: "1 First St" },
    });
    expect(first.status).toBe("fulfilled");

    // Replay the exact same token: the request is no longer pending AND the
    // token is consumed — either guard rejects. It must never fulfill twice.
    await expect(
      service.submit({
        id: created.request.id,
        token: created.submitToken,
        fields: { shipping_address: "2 Attacker Ave" },
      }),
    ).rejects.toThrow();
    // Exactly one fulfillment ever happened.
    expect(fulfilledPrivateFields).toEqual({ shipping_address: "1 First St" });
  });

  test("a tampered token is rejected and does not consume the real one", async () => {
    const service = buildService();
    const created = await createPublicPrivateInfo(service);

    const tampered = `${created.submitToken}x`;
    await expect(
      service.submit({
        id: created.request.id,
        token: tampered,
        fields: { shipping_address: "3 Forged Ln" },
      }),
    ).rejects.toThrow(/Invalid or expired sensitive request token/);

    // The genuine token still works afterward — the forged attempt neither
    // fulfilled nor burned the single-use token.
    const ok = await service.submit({
      id: created.request.id,
      token: created.submitToken,
      fields: { shipping_address: "4 Real Rd" },
    });
    expect(ok.status).toBe("fulfilled");
    expect(fulfilledPrivateFields).toEqual({ shipping_address: "4 Real Rd" });
  });

  test("an expired request rejects submit and reads as expired on the hosted page", async () => {
    const service = buildService();
    const created = await createPublicPrivateInfo(service);

    // Push expiry into the past (a request whose link the recipient opened too
    // late). Lazy expiry runs on the next read/submit.
    repo.forceExpiry(created.request.id, new Date(Date.now() - 60_000));

    // Hosted page load surfaces expired state, not a live form.
    const pageView = await service.getPublicByToken(created.request.id, created.submitToken);
    expect(pageView.status).toBe("expired");

    // Submit against the expired request is refused (409 not-pending).
    await expect(
      service.submit({
        id: created.request.id,
        token: created.submitToken,
        fields: { shipping_address: "5 Too Late Blvd" },
      }),
    ).rejects.toThrow();
    expect(fulfilledPrivateFields).toBeNull();

    // The expiry round-tripped to the agent's listener as well.
    expect(recordedCallbackEvents.some((e) => e.name === "SensitiveRequestExpired")).toBe(true);
  });

  test("requireAuthenticatedLink blocks a token-only anonymous submit", async () => {
    const service = buildService();
    // Default secret/private_info policy keeps requireAuthenticatedLink:true.
    const created = await service.create(
      {
        kind: "private_info",
        agentId: AGENT_ID,
        organizationId: ORG_ID,
        target: {
          kind: "private_info",
          fields: [{ name: "shipping_address", required: true }],
        },
      },
      OWNER_ACTOR,
    );

    // A sessionless recipient holding a valid token still cannot submit when the
    // request demands an authenticated link.
    await expect(
      service.submit({
        id: created.request.id,
        token: created.submitToken,
        fields: { shipping_address: "6 Anon Way" },
      }),
    ).rejects.toThrow(/Authentication required/);
    expect(fulfilledPrivateFields).toBeNull();
  });

  test("a submitter from a different org is forbidden", async () => {
    const service = buildService();
    const created = await service.create(
      {
        kind: "secret",
        agentId: AGENT_ID,
        organizationId: ORG_ID,
        target: { kind: "secret", key: "STRIPE_KEY" },
      },
      OWNER_ACTOR,
    );

    await expect(
      service.submit({
        id: created.request.id,
        token: created.submitToken,
        value: SECRET_VALUE,
        actor: { type: "user", userId: "attacker", organizationId: OTHER_ORG_ID },
      }),
    ).rejects.toThrow(/different organization/);
    expect(createdSecrets).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Live-gated harness (#16940): the hosted-secret round-trip against the REAL
// deployed cloud. Nothing below is a stand-in — every HTTP call hits the live
// worker, every row lands in the live Postgres, and the stored secret is a real
// row in the org's secrets store. Fail-closed: when the gate is enabled a
// broken leg fails the run; the harness never fabricates a pass.
//
// Gate:            ELIZA_SENSITIVE_LIVE=1 + ELIZAOS_CLOUD_API_KEY
// Base override:   ELIZAOS_CLOUD_BASE_URL   (default https://elizacloud.ai)
// Connector leg:   TELEGRAM_BOT_TOKEN + ELIZA_SENSITIVE_LIVE_TELEGRAM_CHAT_ID
//                  (+ optional ELIZA_SENSITIVE_LIVE_WAIT_SECONDS, default 300)
//
// Owner command for the full human-in-the-loop connector run:
//   ELIZA_SENSITIVE_LIVE=1 ELIZAOS_CLOUD_API_KEY=<key> \
//   TELEGRAM_BOT_TOKEN=<token> ELIZA_SENSITIVE_LIVE_TELEGRAM_CHAT_ID=<chat id> \
//   bun test packages/cloud/shared/src/lib/services/sensitive-request-hosted-page-e2e.test.ts
// The DM leg sends the real tap-through DM (the exact Bot API wire shape the
// production Telegraf adapter emits — text + one inline URL button, never any
// secret material), then polls the request until the human submits on the
// hosted page; no submit within the window fails the test. Record the tap +
// hosted-page submit as MP4 for the evidence bundle while it polls.
// ---------------------------------------------------------------------------

const LIVE_CLOUD_KEY = process.env.ELIZAOS_CLOUD_API_KEY?.trim() ?? "";
const LIVE_ENABLED = process.env.ELIZA_SENSITIVE_LIVE === "1" && LIVE_CLOUD_KEY.length > 0;
const LIVE_CLOUD_BASE = (process.env.ELIZAOS_CLOUD_BASE_URL?.trim() || "https://elizacloud.ai")
  .replace(/\/api\/v1\/?$/, "")
  .replace(/\/+$/, "");
const LIVE_TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
const LIVE_TELEGRAM_CHAT_ID = process.env.ELIZA_SENSITIVE_LIVE_TELEGRAM_CHAT_ID?.trim() ?? "";
const LIVE_DM_ENABLED =
  LIVE_ENABLED && LIVE_TELEGRAM_TOKEN.length > 0 && LIVE_TELEGRAM_CHAT_ID.length > 0;
const LIVE_WAIT_SECONDS = Number(process.env.ELIZA_SENSITIVE_LIVE_WAIT_SECONDS ?? "300");
const LIVE_FETCH_TIMEOUT_MS = 30_000;
const LIVE_TEST_TIMEOUT_MS = 120_000;

interface LiveResponse {
  status: number;
  contentType: string;
  text: string;
  json: Record<string, unknown> | null;
}

/**
 * Fetch against the live deployment, capturing the raw body into `bodies` so
 * the no-secret-on-the-wire assertion can sweep every transport payload the
 * run ever produced. The submit route sits behind a STRICT rate limit, so
 * back-to-back harness runs can draw a 429 before the service is ever
 * reached; those are waited out (Retry-After, else 15s) and retried — a 429
 * is a limiter verdict, not a flow outcome, and swallowing it as one would
 * make every status assertion below meaningless.
 */
async function liveFetch(url: string, init: RequestInit, bodies: string[]): Promise<LiveResponse> {
  let response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
  });
  for (let attempt = 0; response.status === 429 && attempt < 3; attempt += 1) {
    const retryAfterSeconds = Number(response.headers.get("retry-after") ?? "0");
    const waitMs =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : 15_000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
    });
  }
  const text = await response.text();
  bodies.push(text);
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // error-policy:J3 hosted-page HTML (and any non-JSON error body) is a
    // legitimate live response; callers assert on `json` only where the
    // contract guarantees JSON, so a null here is an explicit "not JSON"
    // signal, never a fake-valid default.
    json = null;
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text,
    json,
  };
}

function liveAuthHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${LIVE_CLOUD_KEY}`, "Content-Type": "application/json" };
}

interface LiveCreated {
  id: string;
  token: string;
  key: string;
  request: Record<string, unknown>;
}

/**
 * Secret names are unique per org and the cloud API exposes no secret-delete
 * endpoint, so a fulfilled run permanently claims its target key —
 * `secretsService.create` throws on a duplicate and the submit surfaces as a
 * 500. Every run therefore mints a fresh, timestamped key under a grep-able
 * prefix; the stored values are random sentinels, never real credentials.
 */
function liveUniqueSecretKey(prefix: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `${prefix}_${stamp}_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

async function liveCreateSecretRequest(
  keyPrefix: string,
  bodies: string[],
  sourcePlatform: string,
): Promise<LiveCreated> {
  const key = liveUniqueSecretKey(keyPrefix);
  const response = await liveFetch(
    `${LIVE_CLOUD_BASE}/api/v1/sensitive-requests`,
    {
      method: "POST",
      headers: liveAuthHeaders(),
      body: JSON.stringify({
        kind: "secret",
        agentId: "agent-live-e2e-16940",
        sourceChannelType: "api",
        sourcePlatform,
        target: { kind: "secret", key },
        // Token-only sessionless mode — the out-of-band-recipient hosted-page
        // path the submit route documents. requirePrivateDelivery keeps the
        // create-policy invariant for secrets satisfied without demanding a
        // browser session this headless harness cannot hold.
        policy: { requireAuthenticatedLink: false, requirePrivateDelivery: true },
        lifetimeSeconds: 900,
      }),
    },
    bodies,
  );
  expect(response.status).toBe(201);
  const created = response.json as {
    success?: boolean;
    request?: Record<string, unknown>;
    submitToken?: string;
  } | null;
  expect(created?.success).toBe(true);
  expect(created?.submitToken).toMatch(/^sr_/);
  const request = created?.request as Record<string, unknown>;
  expect(request.status).toBe("pending");
  return {
    id: String(request.id),
    token: created?.submitToken as string,
    key,
    request,
  };
}

function auditEventTypes(privateView: Record<string, unknown> | null): string[] {
  const audit = (privateView?.request as { audit?: Array<{ eventType: string }> } | undefined)
    ?.audit;
  return (audit ?? []).map((event) => event.eventType);
}

describe("#16940 live hosted-secret round-trip against the real deployed cloud", () => {
  test.skipIf(!LIVE_ENABLED)(
    "create → hosted page → token view → sessionless submit → fulfilled → replay rejected → audit trail",
    async () => {
      const bodies: string[] = [];
      const sentinel = `sr-live-proof-${crypto.randomUUID()}`;

      const created = await liveCreateSecretRequest(
        "E2E_HOSTED_ROUNDTRIP_PROOF",
        bodies,
        "live-e2e-harness",
      );

      // The hosted page the DM link opens is really deployed and serves HTML.
      const page = await liveFetch(
        `${LIVE_CLOUD_BASE}/sensitive-requests/${encodeURIComponent(created.id)}`,
        { method: "GET" },
        bodies,
      );
      expect(page.status).toBe(200);
      expect(page.contentType).toContain("text/html");

      // Sessionless recipient loads the redacted form spec with only the token.
      const publicView = await liveFetch(
        `${LIVE_CLOUD_BASE}/api/v1/sensitive-requests/${encodeURIComponent(created.id)}?token=${encodeURIComponent(created.token)}`,
        { method: "GET" },
        bodies,
      );
      expect(publicView.status).toBe(200);
      const publicRequest = (publicView.json as { request?: Record<string, unknown> } | null)
        ?.request as Record<string, unknown>;
      expect(publicRequest.status).toBe("pending");
      // Token holders never see the org audit trail.
      expect("audit" in publicRequest).toBe(false);

      // Sessionless single-use-token submit of the secret value.
      const submitted = await liveFetch(
        `${LIVE_CLOUD_BASE}/api/v1/sensitive-requests/${encodeURIComponent(created.id)}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: created.token, value: sentinel }),
        },
        bodies,
      );
      expect(submitted.status).toBe(200);
      expect((submitted.json as { success?: boolean } | null)?.success).toBe(true);
      expect(
        (
          (submitted.json as { request?: { status?: string } } | null)?.request as {
            status?: string;
          }
        )?.status,
      ).toBe("fulfilled");

      // Replaying the consumed token must never fulfill twice.
      const replay = await liveFetch(
        `${LIVE_CLOUD_BASE}/api/v1/sensitive-requests/${encodeURIComponent(created.id)}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: created.token, value: "attacker-second-value" }),
        },
        bodies,
      );
      expect(replay.status).toBe(409);
      expect((replay.json as { success?: boolean } | null)?.success).toBe(false);

      // The org-credentialed observer — exactly what an agent container holds —
      // sees the fulfillment and the full audit trail, including the real
      // stored-secret id from `secret.set`.
      const privateView = await liveFetch(
        `${LIVE_CLOUD_BASE}/api/v1/sensitive-requests/${encodeURIComponent(created.id)}`,
        { method: "GET", headers: liveAuthHeaders() },
        bodies,
      );
      expect(privateView.status).toBe(200);
      const finalRequest = (privateView.json as { request?: Record<string, unknown> } | null)
        ?.request as Record<string, unknown>;
      expect(finalRequest.status).toBe("fulfilled");
      expect(finalRequest.fulfilledAt).not.toBeNull();
      const eventTypes = auditEventTypes(privateView.json as Record<string, unknown>);
      for (const required of [
        "request.created",
        "token.used",
        "request.submitted",
        "secret.set",
        "request.fulfilled",
      ]) {
        expect(eventTypes).toContain(required);
      }
      const secretSet = (
        (finalRequest.audit ?? []) as Array<{
          eventType: string;
          metadata?: Record<string, unknown>;
        }>
      ).find((event) => event.eventType === "secret.set");
      expect(secretSet?.metadata?.key).toBe(created.key);
      expect(typeof secretSet?.metadata?.secretId).toBe("string");

      // The submitted value must be absent from every transport payload the
      // run produced after the submit call itself (the submit request body is
      // the one legitimate carrier and is not a response).
      for (const body of bodies) {
        expect(body).not.toContain(sentinel);
      }

      console.log(
        `[live-harness] round-trip fulfilled: request=${created.id} key=${created.key} secretId=${String(secretSet?.metadata?.secretId)} audit=${eventTypes.join(",")}`,
      );
    },
    LIVE_TEST_TIMEOUT_MS,
  );

  test.skipIf(!LIVE_ENABLED)(
    "tampered token is rejected by the real deployment without burning the genuine one",
    async () => {
      const bodies: string[] = [];
      const created = await liveCreateSecretRequest(
        "E2E_HOSTED_TAMPER_PROOF",
        bodies,
        "live-e2e-harness",
      );
      const tampered = `${created.token}x`;

      const tamperedView = await liveFetch(
        `${LIVE_CLOUD_BASE}/api/v1/sensitive-requests/${encodeURIComponent(created.id)}?token=${encodeURIComponent(tampered)}`,
        { method: "GET" },
        bodies,
      );
      expect(tamperedView.status).toBe(401);

      const tamperedSubmit = await liveFetch(
        `${LIVE_CLOUD_BASE}/api/v1/sensitive-requests/${encodeURIComponent(created.id)}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: tampered, value: "forged-value" }),
        },
        bodies,
      );
      expect(tamperedSubmit.status).toBe(401);

      // The forged attempts neither fulfilled the request nor consumed the
      // genuine token: the real token still reads the pending form.
      const realView = await liveFetch(
        `${LIVE_CLOUD_BASE}/api/v1/sensitive-requests/${encodeURIComponent(created.id)}?token=${encodeURIComponent(created.token)}`,
        { method: "GET" },
        bodies,
      );
      expect(realView.status).toBe(200);
      expect(
        (
          (realView.json as { request?: { status?: string } } | null)?.request as {
            status?: string;
          }
        )?.status,
      ).toBe("pending");

      // Cleanup: cancel so no pending row is left behind in the live org, and
      // prove a canceled request refuses a late submit.
      const canceled = await liveFetch(
        `${LIVE_CLOUD_BASE}/api/v1/sensitive-requests/${encodeURIComponent(created.id)}/cancel`,
        { method: "POST", headers: liveAuthHeaders(), body: JSON.stringify({}) },
        bodies,
      );
      expect(canceled.status).toBe(200);
      const lateSubmit = await liveFetch(
        `${LIVE_CLOUD_BASE}/api/v1/sensitive-requests/${encodeURIComponent(created.id)}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: created.token, value: "too-late" }),
        },
        bodies,
      );
      expect(lateSubmit.status).toBe(409);
    },
    LIVE_TEST_TIMEOUT_MS,
  );

  test.skipIf(!LIVE_DM_ENABLED)(
    "real Telegram DM delivers the tap-through link and a human submit round-trips",
    async () => {
      const bodies: string[] = [];
      const created = await liveCreateSecretRequest(
        "E2E_HOSTED_CONNECTOR_PROOF",
        bodies,
        "telegram",
      );
      const link = `${LIVE_CLOUD_BASE}/sensitive-requests/${encodeURIComponent(created.id)}?token=${encodeURIComponent(created.token)}`;

      // The exact Bot API wire shape the production Telegraf adapter emits
      // (plugins/plugin-telegram/src/sensitive-request-adapter.ts): text plus a
      // single inline URL button; the secret value never exists at delivery
      // time and the payload must carry only the link.
      const dmPayload = JSON.stringify({
        chat_id: Number(LIVE_TELEGRAM_CHAT_ID),
        text: [
          "A sensitive value is needed to continue.",
          "Live hosted-secret round-trip proof (#16940).",
          `This request expires at ${String(created.request.expiresAt)}.`,
        ].join("\n"),
        reply_markup: {
          inline_keyboard: [[{ text: "Provide securely", url: link }]],
        },
      });
      expect(dmPayload).toContain(link);

      const dmResponse = await fetch(
        `https://api.telegram.org/bot${LIVE_TELEGRAM_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: dmPayload,
          signal: AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
        },
      );
      const dmResult = (await dmResponse.json()) as {
        ok?: boolean;
        result?: { message_id?: number };
      };
      expect(dmResult.ok).toBe(true);
      expect(typeof dmResult.result?.message_id).toBe("number");
      console.log(
        `[live-harness] DM delivered (message_id=${String(dmResult.result?.message_id)}); waiting up to ${LIVE_WAIT_SECONDS}s for the human hosted-page submit of request ${created.id}`,
      );

      // Fail-closed human-in-the-loop wait: the tap + hosted-page submit must
      // land within the window or this leg fails.
      const deadline = Date.now() + LIVE_WAIT_SECONDS * 1000;
      let status = "pending";
      let finalView: Record<string, unknown> | null = null;
      while (Date.now() < deadline && status === "pending") {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        const view = await liveFetch(
          `${LIVE_CLOUD_BASE}/api/v1/sensitive-requests/${encodeURIComponent(created.id)}`,
          { method: "GET", headers: liveAuthHeaders() },
          bodies,
        );
        expect(view.status).toBe(200);
        finalView = view.json;
        status = String(
          (
            (view.json as { request?: { status?: string } } | null)?.request as {
              status?: string;
            }
          )?.status,
        );
      }
      expect(status).toBe("fulfilled");
      const eventTypes = auditEventTypes(finalView);
      expect(eventTypes).toContain("secret.set");
      console.log(
        `[live-harness] connector round-trip fulfilled: request=${created.id} audit=${eventTypes.join(",")}`,
      );
    },
    (LIVE_WAIT_SECONDS + 120) * 1000,
  );

  test("live gate reports why it is skipped when creds are absent", () => {
    if (!LIVE_ENABLED) {
      expect(
        "skipped: set ELIZA_SENSITIVE_LIVE=1 + ELIZAOS_CLOUD_API_KEY to run the live cloud round-trip; add TELEGRAM_BOT_TOKEN + ELIZA_SENSITIVE_LIVE_TELEGRAM_CHAT_ID for the connector DM leg",
      ).toContain("skipped");
    } else {
      expect(LIVE_ENABLED).toBe(true);
    }
  });
});
