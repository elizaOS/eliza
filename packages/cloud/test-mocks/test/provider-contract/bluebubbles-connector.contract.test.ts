/**
 * Exercises the production BlueBubbles client, connector registration, and
 * runtime service against the stateful loopback provider. The suite remains
 * mock-only evidence; the separately authorized provider canary owns live
 * qualification and can reuse the same BlueBubbles protocol envelope.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type {
  IAgentRuntime,
  Memory,
  MessageConnectorRegistration,
  UUID,
} from "@elizaos/core";
import { BlueBubblesService } from "@elizaos/plugin-bluebubbles";
import {
  BlueBubblesClient,
  BlueBubblesHttpError,
  BlueBubblesTransportError,
} from "@elizaos/plugin-bluebubbles/client";
import {
  bootInProcessWorld,
  parseWorldManifest,
  SYNTHETIC_WORLD_SCHEMA_VERSION,
  type SyntheticWorld,
} from "@elizaos/synthetic-world";
import { startBlueBubblesMock } from "../../src/bluebubbles";
import { startFetchServer } from "../../src/fetch-server";

const AGENT_ID = "00000000-0000-0000-0000-00000000bb01" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000bb02" as UUID;
const CHAT_GUID = "iMessage;-;+14155552671";
const PERSONAL_PASSWORD = "personal-p@ss/word?&";
const WORK_PASSWORD = "work-secret";
const WEBHOOK_SECRET = "webhook-secret";

type RunningBlueBubblesMock = Awaited<ReturnType<typeof startBlueBubblesMock>>;

const worlds: SyntheticWorld[] = [];
const mocks: RunningBlueBubblesMock[] = [];
const targets: Array<Awaited<ReturnType<typeof startFetchServer>>> = [];
let namespaceSequence = 0;

afterEach(async () => {
  await Promise.allSettled(targets.splice(0).map((target) => target.stop()));
  await Promise.allSettled(mocks.splice(0).map((provider) => provider.stop()));
  for (const world of worlds.splice(0)) world.teardown();
});

function createWorld(label: string): SyntheticWorld {
  const world = bootInProcessWorld(
    parseWorldManifest({
      schemaVersion: SYNTHETIC_WORLD_SCHEMA_VERSION,
      worldId: `bluebubbles-${label}`,
      seed: `bluebubbles-${label}-v1`,
      clock: { epoch: "2032-04-05T06:07:08.000Z", timezone: "UTC" },
      data: {},
    }),
    { namespace: `bluebubbles:${label}:${++namespaceSequence}` },
  );
  worlds.push(world);
  return world;
}

function chat(displayName: string) {
  return {
    guid: CHAT_GUID,
    chatIdentifier: "+14155552671",
    displayName,
    participants: [{ address: "+14155552671", service: "iMessage" }],
  };
}

async function provider(
  world: SyntheticWorld,
): Promise<RunningBlueBubblesMock> {
  const running = await startBlueBubblesMock({
    world,
    accounts: [
      {
        accountId: "personal",
        password: PERSONAL_PASSWORD,
        chats: [chat("Alice Personal")],
      },
      {
        accountId: "work",
        password: WORK_PASSWORD,
        chats: [chat("Alice Work")],
      },
    ],
  });
  mocks.push(running);
  return running;
}

function protocolMessage(
  guid: string,
  text: string,
  dateCreated: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const handle = {
    address: "+14155552671",
    service: "iMessage",
    country: null,
    originalROWID: 1,
    uncanonicalizedId: null,
  };
  return {
    guid,
    text,
    subject: null,
    country: null,
    handle,
    handleId: 1,
    otherHandle: 0,
    chats: [
      {
        ...chat("Alice Personal"),
        participants: [handle],
        lastMessage: null,
        style: 45,
        isArchived: false,
        isFiltered: false,
        isPinned: false,
        hasUnreadMessages: false,
      },
    ],
    attachments: [],
    expressiveSendStyleId: null,
    dateCreated,
    dateRead: null,
    dateDelivered: null,
    isFromMe: false,
    isDelayed: false,
    isAutoReply: false,
    isSystemMessage: false,
    isServiceMessage: false,
    isForward: false,
    isArchived: false,
    hasDdResults: false,
    hasPayloadData: false,
    threadOriginatorGuid: null,
    threadOriginatorPart: null,
    associatedMessageGuid: null,
    associatedMessageType: null,
    balloonBundleId: null,
    dateEdited: null,
    error: 0,
    itemType: 0,
    groupTitle: null,
    groupActionType: 0,
    payloadData: null,
    ...overrides,
  };
}

function runtimeFor(
  serverUrl: string,
  registrations: MessageConnectorRegistration[],
) {
  const memories = new Map<string, Memory>();
  const entities = new Map<string, unknown>();
  const rooms = new Map<string, { id: UUID; channelId: string }>();
  const handled: Memory[] = [];
  const settings: Record<string, string> = {
    BLUEBUBBLES_SERVER_URL: serverUrl,
    BLUEBUBBLES_PASSWORD: PERSONAL_PASSWORD,
    BLUEBUBBLES_WEBHOOK_SECRET: WEBHOOK_SECRET,
    BLUEBUBBLES_DM_POLICY: "open",
    BLUEBUBBLES_SEND_READ_RECEIPTS: "false",
  };
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "BlueBubbles Contract Agent", settings: {} },
    getSetting: (key: string) => settings[key],
    getService: () => null,
    registerMessageConnector: (registration: MessageConnectorRegistration) => {
      registrations.push(registration);
    },
    getMessageConnectors: () => registrations,
    registerSendHandler: () => undefined,
    getMemoryById: async (id: UUID) => memories.get(String(id)) ?? null,
    createMemory: async (memory: Memory) => {
      if (memory.id && !memories.has(String(memory.id))) {
        memories.set(String(memory.id), structuredClone(memory));
      }
      return memory.id;
    },
    updateMemory: async (memory: Memory) => {
      if (!memory.id || !memories.has(String(memory.id))) return false;
      memories.set(String(memory.id), structuredClone(memory));
      return true;
    },
    getMemories: async () => [...memories.values()],
    getEntityById: async (id: UUID) => entities.get(String(id)) ?? null,
    createEntity: async (entity: { id?: UUID }) => {
      if (entity.id) entities.set(String(entity.id), structuredClone(entity));
      return entity.id;
    },
    ensureConnection: async (input: { roomId: UUID; channelId: string }) => {
      rooms.set(String(input.roomId), {
        id: input.roomId,
        channelId: input.channelId,
      });
    },
    getRoom: async (id: UUID) => rooms.get(String(id)) ?? null,
    messageService: {
      handleMessage: async (_runtime: IAgentRuntime, memory: Memory) => {
        handled.push(structuredClone(memory));
      },
    },
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
  return { runtime, memories, handled };
}

async function waitForVirtualTimer(world: SyntheticWorld): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (world.clock.pendingTimerCount > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("BlueBubbles contract did not schedule its virtual timer");
}

describe("BlueBubbles production connector and service contract", () => {
  test("boots the real service, drives egress, ingests ordered webhooks, and suppresses duplicates", async () => {
    const world = createWorld("service");
    const upstream = await provider(world);
    const registrations: MessageConnectorRegistration[] = [];
    const { runtime, memories, handled } = runtimeFor(
      upstream.url,
      registrations,
    );
    const service = await BlueBubblesService.start(runtime);
    expect(service.getIsRunning()).toBe(true);
    BlueBubblesService.registerSendHandlers(runtime, service);

    expect(registrations.map(({ source }) => source)).toEqual([
      "bluebubbles",
      "imessage",
    ]);
    const connector = registrations.find(
      ({ source }) => source === "bluebubbles",
    );
    const outbound = await connector?.sendHandler?.(
      runtime,
      { source: "bluebubbles", channelId: "+14155552671", roomId: ROOM_ID },
      { text: "production egress through the mock" },
    );
    const outboundMemory =
      outbound && "kind" in outbound
        ? outbound.kind === "delivered" ||
          outbound.kind === "partially_delivered"
          ? outbound.memories[0]
          : undefined
        : outbound;
    expect(outboundMemory?.metadata).toMatchObject({
      accountId: "default",
      bluebubblesChatGuid: CHAT_GUID,
    });
    expect(
      upstream.ledger.filter(
        ({ kind, operation, outcome }) =>
          kind === "effect" &&
          operation === "message.send" &&
          outcome === "succeeded",
      ),
    ).toHaveLength(1);

    let failNext = false;
    const observedHeaders: Headers[] = [];
    const target = await startFetchServer(async (request) => {
      observedHeaders.push(new Headers(request.headers));
      if (
        request.headers.get("x-bluebubbles-webhook-secret") !== WEBHOOK_SECRET
      ) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (failNext) {
        failNext = false;
        return Response.json({ error: "retry" }, { status: 503 });
      }
      const payload = (await request.json()) as {
        type: string;
        data: Record<string, unknown>;
      };
      await service.handleWebhook(payload);
      return Response.json({ accepted: true });
    });
    targets.push(target);
    const targetUrl = `http://${target.hostname}:${target.port}/webhook`;
    const inbound = protocolMessage(
      "inbound-guid-1",
      "real ingress through the service",
      world.clock.now().getTime(),
    );
    const event = {
      id: "event-inbound-1",
      sequence: 2,
      accountId: "personal",
      type: "new-message" as const,
      data: inbound,
    };

    expect(
      (
        await upstream.deliverWebhook(targetUrl, event, "wrong", {
          maxAttempts: 1,
        })
      )[0]?.status,
    ).toBe(401);
    await upstream.deliverWebhook(targetUrl, event, WEBHOOK_SECRET);
    await upstream.deliverWebhook(targetUrl, event, WEBHOOK_SECRET);
    expect(handled).toHaveLength(1);
    expect(
      [...memories.values()].filter(
        (memory) =>
          (memory.metadata as Record<string, unknown> | undefined)
            ?.bluebubblesMessageGuid === "inbound-guid-1",
      ),
    ).toHaveLength(1);

    await upstream.deliverWebhook(
      targetUrl,
      {
        id: "event-update-new",
        sequence: 4,
        accountId: "personal",
        type: "updated-message",
        data: { ...inbound, text: "new edit", dateEdited: 400 },
      },
      WEBHOOK_SECRET,
    );
    await upstream.deliverWebhook(
      targetUrl,
      {
        id: "event-update-stale",
        sequence: 3,
        accountId: "personal",
        type: "updated-message",
        data: { ...inbound, text: "stale edit", dateEdited: 300 },
      },
      WEBHOOK_SECRET,
    );
    const edited = [...memories.values()].find(
      (memory) =>
        (memory.metadata as Record<string, unknown> | undefined)
          ?.bluebubblesMessageGuid === "inbound-guid-1",
    );
    expect(edited?.content.text).toBe("new edit");

    failNext = true;
    const retrying = upstream.deliverWebhook(
      targetUrl,
      {
        ...event,
        id: "event-retry",
        sequence: 5,
        data: protocolMessage(
          "inbound-guid-2",
          "retry ingress",
          world.clock.now().getTime(),
        ),
      },
      WEBHOOK_SECRET,
      { retryDelayMs: 1_000 },
    );
    await waitForVirtualTimer(world);
    expect(world.clock.pendingTimerCount).toBe(1);
    await world.clock.advanceBy(999);
    expect(world.clock.pendingTimerCount).toBe(1);
    await world.clock.advanceBy(1);
    expect((await retrying).map(({ status }) => status)).toEqual([503, 200]);

    for (const headers of observedHeaders) {
      expect(headers.get("x-bluebubbles-event-id")).toBeNull();
      expect(headers.get("x-bluebubbles-event-sequence")).toBeNull();
      expect(headers.get("x-bluebubbles-account-id")).toBeNull();
    }
    expect(
      upstream.ledger.some(
        ({ kind, detail }) => kind === "webhook" && detail.outOfOrder === true,
      ),
    ).toBe(true);
    await service.stop();
  });

  test("preserves rejected versus ambiguous sends, idempotent readback, cancellation, timeout, and account isolation", async () => {
    const world = createWorld("client");
    const upstream = await provider(world);
    const personal = new BlueBubblesClient(
      { serverUrl: upstream.url, password: PERSONAL_PASSWORD },
      { requestTimeoutMs: 10 },
    );
    const work = new BlueBubblesClient({
      serverUrl: upstream.url,
      password: WORK_PASSWORD,
    });

    const personalResult = await personal.sendMessage(CHAT_GUID, "personal", {
      tempGuid: "personal-once",
    });
    const replay = await personal.sendMessage(CHAT_GUID, "personal", {
      tempGuid: "personal-once",
    });
    const workResult = await work.sendMessage(CHAT_GUID, "work", {
      tempGuid: "work-once",
    });
    expect(replay.guid).toBe(personalResult.guid);
    expect(workResult.guid).not.toBe(personalResult.guid);

    await expect(
      personal.sendMessage("iMessage;-;+19999999999", "invalid"),
    ).rejects.toMatchObject({
      name: "BlueBubblesHttpError",
      statusCode: 422,
      acceptance: "rejected",
    });

    await upstream.control.fault("POST", "/api/v1/message/text", {
      type: "status",
      status: 500,
    });
    await expect(
      personal.sendMessage(CHAT_GUID, "ambiguous", {
        tempGuid: "ambiguous-once",
      }),
    ).rejects.toMatchObject({
      name: "BlueBubblesHttpError",
      statusCode: 500,
      acceptance: "ambiguous",
    });
    const ambiguousReplay = await personal.sendMessage(CHAT_GUID, "ambiguous", {
      tempGuid: "ambiguous-once",
    });
    const afterAmbiguous = await upstream.control.snapshot();
    const personalState = (
      afterAmbiguous.state.accounts as Array<{
        accountId: string;
        messages: Array<{ tempGuid?: string }>;
      }>
    ).find(({ accountId }) => accountId === "personal");
    expect(
      personalState?.messages.filter(
        ({ tempGuid }) => tempGuid === "ambiguous-once",
      ),
    ).toHaveLength(1);
    expect(ambiguousReplay.guid).toContain("msg-personal");

    await upstream.control.fault("POST", "/api/v1/message/text", {
      type: "delay",
      durationMs: 1_000,
    });
    const cancellation = new AbortController();
    const cancelled = personal.sendMessage(CHAT_GUID, "cancelled", {
      tempGuid: "cancelled-once",
      signal: cancellation.signal,
    });
    await waitForVirtualTimer(world);
    cancellation.abort(new DOMException("operator cancelled", "AbortError"));
    await expect(cancelled).rejects.toBeInstanceOf(BlueBubblesTransportError);
    await world.clock.advanceBy(1_000);
    const cancelledReadback = await personal.sendMessage(
      CHAT_GUID,
      "cancelled",
      {
        tempGuid: "cancelled-once",
      },
    );
    expect(cancelledReadback.guid).toContain("msg-personal");

    await upstream.control.fault("POST", "/api/v1/message/text", {
      type: "delay",
      durationMs: 1_000,
    });
    const timedOut = personal.sendMessage(CHAT_GUID, "timeout", {
      tempGuid: "timeout-once",
    });
    await waitForVirtualTimer(world);
    await expect(timedOut).rejects.toMatchObject({
      name: "BlueBubblesTransportError",
      kind: "timeout",
      acceptance: "ambiguous",
    });
    await world.clock.advanceBy(1_000);

    const encoded = encodeURIComponent(PERSONAL_PASSWORD);
    await upstream.control.fault("POST", "/api/v1/message/text", {
      type: "status",
      status: 401,
      body: {
        status: 401,
        message: `raw=${PERSONAL_PASSWORD}; encoded=${encoded}`,
      },
      headers: {
        "retry-after": "7",
        "x-eliza-mock-commit-before-response": "true",
      },
    });
    let redactedError: unknown;
    try {
      await personal.sendMessage(CHAT_GUID, "redaction");
    } catch (error) {
      redactedError = error;
    }
    expect(redactedError).toBeInstanceOf(BlueBubblesHttpError);
    expect(redactedError).toMatchObject({
      retryAfterSeconds: 7,
      acceptance: "rejected",
    });
    expect(String(redactedError)).not.toContain(PERSONAL_PASSWORD);
    expect(String(redactedError)).not.toContain(encoded);

    const ledgerText = JSON.stringify(
      (await upstream.control.snapshot()).state,
    );
    expect(ledgerText).not.toContain(PERSONAL_PASSWORD);
    expect(ledgerText).not.toContain(encoded);
  });

  test("restores seeded state, pending faults, ledgers, and execution hash", async () => {
    const world = createWorld("reset");
    const upstream = await provider(world);
    const client = new BlueBubblesClient({
      serverUrl: upstream.url,
      password: PERSONAL_PASSWORD,
    });
    const initial = await upstream.control.snapshot();
    await client.sendMessage(CHAT_GUID, "mutated", { tempGuid: "reset-once" });
    await upstream.control.fault("GET", "/api/v1/server/info", {
      type: "status",
      status: 503,
    });
    expect(upstream.ledger.length).toBeGreaterThan(0);

    const reset = await upstream.control.reset();
    expect(reset.state).toMatchObject({ pendingFaults: [], ledger: [] });
    expect(reset.executionStateHash).toBe(initial.executionStateHash);
    expect(reset.controlLedger).toEqual([]);
    expect((await client.listChats()).map(({ guid }) => guid)).toEqual([
      CHAT_GUID,
    ]);
  });
});
