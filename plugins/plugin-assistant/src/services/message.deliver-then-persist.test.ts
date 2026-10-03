/**
 * Reply delivery and durable storage on the simple fast path run concurrently,
 * so connector latency and the response-memory write do not add serially. Both
 * still settle before handleMessage resolves: a callback failure never loses
 * the memory, a persist failure reaches the boundary, and a same-room follow-up
 * fired off delivery is barred from composing until the reply row is stored
 * while other rooms stay unblocked.
 * Real AgentRuntime + SQLiteDatabaseAdapter end to end; only the Stage-1
 * model surface is a deterministic registered handler (no live model, no
 * network). The runtime wrapper observes/faults/holds persistence before the
 * adapter transaction begins, and delegates real writes to the real adapter.
 */

import type { Content, Memory } from "@elizaos/core";
import {
  AgentRuntime,
  asUUID,
  attestDeliveryAudienceFromCanonicalRoom,
  authorizeOwnerExclusiveDisclosure,
  ChannelType,
  createCharacter,
  EventType,
  inferenceTimingRegistry,
  ModelType,
  PRIVACY_DENIED_TEXT,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing";
import { v4 } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantPlugin } from "../index.ts";
import {
  DefaultMessageService,
  enforceTrustedDeliveryAudienceOnResult,
} from "./message.ts";

/** The Stage-1 HANDLE_RESPONSE tool-call envelope a live model emits. */
function stage1DirectReply(replyText: string) {
  return {
    text: "",
    toolCalls: [
      {
        id: "handle-response-1",
        name: "HANDLE_RESPONSE",
        arguments: {
          shouldRespond: "RESPOND",
          thought: "Direct answer.",
          contexts: ["simple"],
          intents: [],
          candidateActionNames: [],
          replyText,
          facts: [],
          relationships: [],
          addressedTo: [],
        },
      },
    ],
    finishReason: "tool_calls",
  };
}

const activeRuntimes: AgentRuntime[] = [];
const releasePersistenceGates: Array<() => void> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const release of releasePersistenceGates.splice(0)) release();
  await Promise.all(
    activeRuntimes.splice(0).map(async (runtime) => {
      await runtime.stop();
      await runtime.close();
    }),
  );
});

interface HarnessOptions {
  /** Artificial latency injected on the agent-reply row write only. */
  persistDelayMs?: number;
  /** Fail the agent-reply row write only (incoming-message write succeeds). */
  failReplyPersist?: boolean;
  /**
   * Hold the FIRST agent-reply row write open until `releaseReplyPersist()`
   * is called — a deterministic, sleep-free window for the compose-vs-persist
   * race tests. Later reply writes (follow-up turns) are never held.
   */
  holdReplyPersist?: boolean;
  /** Deterministic interleaving point after Stage-1 reads state, before egress. */
  beforeStage1Return?: (runtime: AgentRuntime) => Promise<void>;
}

async function createHarness(opts: HarnessOptions = {}) {
  const replyText = `the build finished clean, all green. probe-${v4()}`;
  const followUpReplyText = `and the tests passed too. probe-${v4()}`;
  const runtime = new AgentRuntime({
    plugins: [createAssistantPlugin()],
    character: createCharacter({
      name: `DeliverThenPersist${v4().slice(0, 8)}`,
    }),

    logLevel: "fatal",
    enableAutonomy: false,
  });
  const adapter = SQLiteDatabaseAdapter.create(":memory:", runtime.agentId);
  runtime.registerDatabaseAdapter(adapter);
  activeRuntimes.push(runtime);
  await runtime.initialize();
  // Interleaving trace shared by the model handler and the storage seam.
  const order: string[] = [];
  // Serialized `messages` model input per Stage-1 invocation — lets tests
  // assert what a turn's composed prompt actually contained.
  const stage1Invocations: string[] = [];
  runtime.registerModel(
    ModelType.RESPONSE_HANDLER,
    async (_rt, params) => {
      const invocation = stage1Invocations.length + 1;
      stage1Invocations.push(
        JSON.stringify((params as { messages?: unknown }).messages ?? null),
      );
      order.push(`stage1:${invocation}`);
      await opts.beforeStage1Return?.(runtime);
      return stage1DirectReply(
        invocation === 1 ? replyText : followUpReplyText,
      );
    },
    "deterministic-test",
  );

  const roomId = asUUID(v4());
  const entityId = asUUID(v4());
  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId: asUUID(v4()),
    userName: "tester",
    name: "tester",
    source: "test",
    type: ChannelType.DM,
  });

  // Observation-only storage seam: records when the agent-reply row write
  // COMPLETES relative to the delivery callback, and optionally injects
  // latency, a hold-open gate, or a fault for the failure/race tests. Real
  // writes always reach the real SQLite adapter.
  let releaseReplyPersist: () => void = () => {};
  const replyPersistGate = new Promise<void>((resolve) => {
    releaseReplyPersist = resolve;
  });
  releasePersistenceGates.push(releaseReplyPersist);
  // Hold before SQLite's transaction queue so unrelated rooms can still write.
  const realCreateMessageMemory = runtime.createMessageMemory.bind(runtime);
  runtime.createMessageMemory = async (memory, unique) => {
    const isReplyWrite =
      memory.entityId === runtime.agentId && memory.content?.text === replyText;
    if (isReplyWrite && opts.persistDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, opts.persistDelayMs));
    }
    if (isReplyWrite && opts.holdReplyPersist) {
      await replyPersistGate;
    }
    if (isReplyWrite && opts.failReplyPersist) {
      throw new Error("injected reply-persist failure");
    }
    const id = await realCreateMessageMemory(memory, unique);
    if (isReplyWrite) {
      order.push("persist:reply");
    }
    return id;
  };

  const makeMessage = (): Memory => ({
    id: asUUID(v4()),
    entityId,
    agentId: runtime.agentId,
    roomId,
    content: {
      text: "how did the build go?",
      source: "test",
      channelType: ChannelType.DM,
    },
    createdAt: Date.now(),
  });

  const makeFollowUp = (): Memory => ({
    id: asUUID(v4()),
    entityId,
    agentId: runtime.agentId,
    roomId,
    content: {
      text: "nice — and did the tests pass?",
      source: "test",
      channelType: ChannelType.DM,
    },
    createdAt: Date.now(),
  });

  /** A second, unrelated room on the same runtime (cross-room isolation). */
  const createSecondRoom = async () => {
    const otherRoomId = asUUID(v4());
    const otherEntityId = asUUID(v4());
    await runtime.ensureConnection({
      entityId: otherEntityId,
      roomId: otherRoomId,
      worldId: asUUID(v4()),
      userName: "tester-b",
      name: "tester-b",
      source: "test",
      type: ChannelType.DM,
    });
    const makeRoomBMessage = (): Memory => ({
      id: asUUID(v4()),
      entityId: otherEntityId,
      agentId: runtime.agentId,
      roomId: otherRoomId,
      content: {
        text: "unrelated question from another room",
        source: "test",
        channelType: ChannelType.DM,
      },
      createdAt: Date.now(),
    });
    return { roomId: otherRoomId, makeRoomBMessage };
  };

  const storedReplies = async (): Promise<Memory[]> => {
    const memories = await runtime.getMemories({
      roomId,
      tableName: "messages",
      count: 100,
    });
    return memories.filter(
      (m) => m.entityId === runtime.agentId && m.content.text === replyText,
    );
  };

  const service = new DefaultMessageService();
  return {
    runtime,
    service,
    roomId,
    replyText,
    followUpReplyText,
    order,
    stage1Invocations,
    makeMessage,
    makeFollowUp,
    createSecondRoom,
    releaseReplyPersist,
    storedReplies,
  };
}

describe("simple-path deliver-then-persist ordering", () => {
  it.each([
    ["1", "analysis"],
    ["0", "analysis"],
    ["1", "as you were"],
    ["0", "as you were"],
  ])(
    "handles ordinary text with retired analysis gate %s: %s",
    async (gate, text) => {
      vi.stubEnv("ELIZA_ENABLE_ANALYSIS_MODE", gate);
      const h = await createHarness();
      const message = h.makeMessage();
      message.content.text = text;
      const delivered: string[] = [];
      const result = await h.service.handleMessage(
        h.runtime,
        message,
        async (content) => {
          if (content.text) delivered.push(content.text);
          return [];
        },
      );
      expect(h.stage1Invocations).toHaveLength(1);
      expect(h.stage1Invocations[0]).toContain(text);
      expect(result.didRespond).toBe(true);
      expect(delivered).toContain(h.replyText);
      expect(await h.storedReplies()).toHaveLength(1);
      if (!message.id) throw new Error("Fixture message requires an ID");
      expect((await h.runtime.getMemoryById(message.id))?.content.text).toBe(
        text,
      );
    },
  );

  it("fires the delivery callback before the reply persist completes, then still persists it", async () => {
    const h = await createHarness({ holdReplyPersist: true });
    let orderAtDelivery: string[] | undefined;
    let deliveryActionName: string | undefined;

    const result = await h.service.handleMessage(
      h.runtime,
      h.makeMessage(),
      async (_content, actionName) => {
        h.order.push("callback");
        deliveryActionName = actionName;
        // Hold the real storage boundary until delivery enters. This proves
        // a slow write cannot block delivery without assuming asynchronous
        // privacy checks and an immediate in-memory write settle in order.
        orderAtDelivery = [...h.order];
        h.releaseReplyPersist();
        return [];
      },
    );

    expect(result.didRespond).toBe(true);
    expect(result.mode).toBe("simple");
    expect(result.responseContent?.text).toBe(h.replyText);
    expect(deliveryActionName).toBeUndefined();
    expect(orderAtDelivery).toEqual(["stage1:1", "callback"]);
    expect(h.order).toEqual(["stage1:1", "callback", "persist:reply"]);
    expect(result.persistedResponseMessageIds).toHaveLength(1);

    // The persist completed before handleMessage resolved: an immediate
    // next-turn-style read sees exactly one stored reply — no drop, no
    // double-persist.
    const replies = await h.storedReplies();
    expect(replies).toHaveLength(1);
    expect(replies[0].content.text).toBe(h.replyText);
  });

  it("replaces private callback, persistence, event, and returned content when membership changes", async () => {
    const guest = asUUID(v4());
    let privateRoomId: UUID | undefined;
    const h = await createHarness({
      beforeStage1Return: async (runtime) => {
        if (!privateRoomId) throw new Error("private room not initialized");
        await runtime.addParticipant(guest, privateRoomId);
      },
    });
    privateRoomId = h.roomId;
    const turn = h.makeMessage();
    h.runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", turn.entityId);
    h.runtime.registerProvider({
      name: "userPersonalityPreferences",
      override: true,
      disclosureGate: { require: "owner_exclusive" },
      alwaysInResponseState: true,
      get: async () => ({ text: "OWNER_PRIVATE_PROVIDER_CANARY" }),
    });
    await attestDeliveryAudienceFromCanonicalRoom(h.runtime, turn);

    const delivered: Content[] = [];
    const messageSentContents: Content[] = [];
    const emitEvent = h.runtime.emitEvent.bind(h.runtime);
    h.runtime.emitEvent = (async (event, payload) => {
      if (event === EventType.MESSAGE_SENT) {
        const sentMessage = (payload as { message?: Memory }).message;
        if (sentMessage) messageSentContents.push(sentMessage.content);
      }
      return emitEvent(event, payload);
    }) as AgentRuntime["emitEvent"];

    const result = await h.service.handleMessage(
      h.runtime,
      turn,
      async (content) => {
        delivered.push(content);
        return [];
      },
    );
    const stored = await h.runtime.getMemories({
      roomId: h.roomId,
      tableName: "messages",
      count: 100,
    });
    const observable = JSON.stringify({
      delivered,
      messageSentContents,
      responseContent: result.responseContent,
      responseMessages: result.responseMessages.map((memory) => memory.content),
      stored: stored.filter((memory) => memory.entityId === h.runtime.agentId),
    });

    expect(observable).not.toContain(h.replyText);
    expect(observable).not.toContain("OWNER_PRIVATE_PROVIDER_CANARY");
    expect(delivered).toEqual([
      expect.objectContaining({ text: PRIVACY_DENIED_TEXT }),
    ]);
    expect(result.responseContent?.text).toBe(PRIVACY_DENIED_TEXT);
    expect(
      stored.some(
        (memory) =>
          memory.entityId === h.runtime.agentId &&
          memory.content.text === PRIVACY_DENIED_TEXT,
      ),
    ).toBe(true);
  });

  it("rewrites every actions-mode response memory after the audience changes", async () => {
    const h = await createHarness();
    const turn = h.makeMessage();
    h.runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", turn.entityId);
    await attestDeliveryAudienceFromCanonicalRoom(h.runtime, turn);
    expect(
      await authorizeOwnerExclusiveDisclosure(h.runtime, turn),
    ).toMatchObject({ allowed: true });
    await h.runtime.addParticipant(asUUID(v4()), h.roomId);

    const actionCanary = "OWNER_PRIVATE_ACTION_RESULT_CANARY";
    const responseMessages: Memory[] = ["first", "second"].map(
      (label, index) => ({
        id: asUUID(v4()),
        entityId: h.runtime.agentId,
        agentId: h.runtime.agentId,
        roomId: h.roomId,
        createdAt: Date.now() + index,
        content: {
          text: `${label}: ${actionCanary}`,
          data: { actionCanary },
        },
      }),
    );

    const result = await enforceTrustedDeliveryAudienceOnResult(
      h.runtime,
      turn,
      {
        text: `top-level: ${actionCanary}`,
        data: { actionCanary },
      },
      responseMessages,
    );

    expect(JSON.stringify(result)).not.toContain(actionCanary);
    expect(result.responseContent?.text).toBe(PRIVACY_DENIED_TEXT);
    expect(result.responseMessages).toHaveLength(2);
    expect(
      result.responseMessages.every(
        (memory) => memory.content.text === PRIVACY_DENIED_TEXT,
      ),
    ).toBe(true);
  });

  it("still persists the reply when the delivery callback throws, then rethrows that exact error", async () => {
    const h = await createHarness({ holdReplyPersist: true });
    const boom = new Error("connector send failed");

    await expect(
      h.service.handleMessage(h.runtime, h.makeMessage(), async () => {
        h.order.push("callback-throw");
        h.releaseReplyPersist();
        throw boom;
      }),
    ).rejects.toBe(boom);

    // The memory was persisted despite the delivery failure, and the error
    // surfaced identity-preserved at the handleMessage boundary.
    expect(h.order).toEqual(["stage1:1", "callback-throw", "persist:reply"]);
    expect(await h.storedReplies()).toHaveLength(1);
  });

  it("propagates a reply-persist failure to the handleMessage boundary after the user got the reply", async () => {
    const h = await createHarness({ failReplyPersist: true });
    const delivered: Content[] = [];

    await expect(
      h.service.handleMessage(h.runtime, h.makeMessage(), async (content) => {
        delivered.push(content);
        return [];
      }),
    ).rejects.toThrow("injected reply-persist failure");

    // Delivery happened first; the persist failure was NOT swallowed.
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toBe(h.replyText);
  });

  it("keeps both failures observable when the callback AND the persist fail", async () => {
    const h = await createHarness({ failReplyPersist: true });
    const reported: unknown[] = [];
    const realReportError = h.runtime.reportError.bind(h.runtime);
    h.runtime.reportError = ((scope, error, context) => {
      if (scope === "MessageService.simpleDeliveryCallback") {
        reported.push(error);
      }
      return realReportError(scope, error, context);
    }) as AgentRuntime["reportError"];
    const boom = new Error("connector send failed");

    // The persist failure propagates (data loss outranks delivery failure);
    // the held delivery failure is reported, never silently superseded.
    await expect(
      h.service.handleMessage(h.runtime, h.makeMessage(), async () => {
        throw boom;
      }),
    ).rejects.toThrow("injected reply-persist failure");
    expect(reported).toEqual([boom]);
  });

  it("overlaps reply delivery with persistence and records reply time independently", async () => {
    const h = await createHarness({ persistDelayMs: 150 });
    let observedTurnId: string | undefined;

    await h.service.handleMessage(
      h.runtime,
      h.makeMessage(),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [];
      },
      {
        onInferenceTimingSummary: (summary) => {
          observedTurnId = summary.turnId;
        },
      },
    );

    const turn = inferenceTimingRegistry.recentTurns(1)[0];
    expect(turn).toBeDefined();
    expect(observedTurnId).toBe(turn.turnId);
    const callbackSpan = turn.spans.find(
      (s) => s.name === "message:delivery:callback",
    );
    const persistSpan = turn.spans.find(
      (s) => s.name === "message:delivery:persistence",
    );
    expect(callbackSpan).toBeDefined();
    expect(persistSpan).toBeDefined();
    if (!callbackSpan || !persistSpan) return;

    // Both operations are in flight together, while the reply mark follows
    // the callback rather than waiting for the slower durable write.
    expect(persistSpan.startMs).toBeLessThanOrEqual(callbackSpan.endMs);
    expect(persistSpan.durationMs).toBeGreaterThanOrEqual(140);
    expect(turn.timeToReplyMs).not.toBeNull();
    expect(turn.timeToReplyMs as number).toBeLessThanOrEqual(persistSpan.endMs);
  });

  it("bars a same-room follow-up fired from the delivery callback from composing until the reply persist completes", async () => {
    // THE race deliver-then-persist opens up: the client reacts to the
    // delivered reply while the reply row is still being written. The
    // follow-up's compose must wait for the persist barrier, or its
    // RECENT_MESSAGES omits the very reply it is answering. The persist is
    // held open by a gate (no timing games): if the barrier did not work,
    // the follow-up's Stage-1 would run while the gate is still closed.
    const h = await createHarness({ holdReplyPersist: true });
    let followUpTurn: Promise<unknown> | null = null;

    const firstTurn = h.service.handleMessage(
      h.runtime,
      h.makeMessage(),
      async () => {
        h.order.push("callback");
        // Fire-and-forget, exactly like a real client reacting to the
        // delivered reply. A callback must never AWAIT a same-room turn
        // to completion (documented on registerPendingReplyPersist).
        followUpTurn = h.service.handleMessage(
          h.runtime,
          h.makeFollowUp(),
          async () => [],
        );
        return [];
      },
    );

    // Give the follow-up every opportunity to (incorrectly) reach Stage-1
    // while the first reply's persist is still held open.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.order).toContain("callback");
    expect(h.order).not.toContain("stage1:2");

    h.releaseReplyPersist();
    await firstTurn;
    expect(followUpTurn).not.toBeNull();
    await followUpTurn;

    // Stage-1 for the follow-up ran only after the reply row was stored…
    expect(h.order.indexOf("persist:reply")).toBeGreaterThan(-1);
    expect(h.order.indexOf("stage1:2")).toBeGreaterThan(
      h.order.indexOf("persist:reply"),
    );
    // …and its composed model input actually contains the delivered reply.
    expect(h.stage1Invocations).toHaveLength(2);
    expect(h.stage1Invocations[1]).toContain(h.replyText);
  });

  it("lets a different room proceed while another room's reply persist is still pending", async () => {
    // The barrier is per-room: holding room A's reply persist open must not
    // serialize room B behind it.
    const h = await createHarness({ holdReplyPersist: true });
    const roomB = await h.createSecondRoom();

    let roomADelivered: () => void = () => {};
    const delivered = new Promise<void>((resolve) => {
      roomADelivered = resolve;
    });
    const turnA = h.service.handleMessage(
      h.runtime,
      h.makeMessage(),
      async () => {
        roomADelivered();
        return [];
      },
    );

    // Room A's reply is delivered and its persist is now held open.
    await delivered;
    const resultB = await h.service.handleMessage(
      h.runtime,
      roomB.makeRoomBMessage(),
      async () => [],
    );

    // Room B ran to completion while room A's persist never finished.
    expect(resultB.didRespond).toBe(true);
    expect(h.order).not.toContain("persist:reply");

    h.releaseReplyPersist();
    await turnA;
    expect(h.order).toContain("persist:reply");
  });
});

describe("planning progress delivery boundaries", () => {
  it.each([
    'Notes is open. Your latest note is "QA handoff September 24." Your next saved event is "QA handoff September 25," today from 10:00 to 10:15 AM PDT. Nothing was created, edited, or deleted.',
    "Checking now. Your next saved event is at 10:00 AM.",
    "Checking that now.",
  ])(
    "holds ungrounded read answers while permitting only genuine progress: %s",
    async (draft) => {
      const h = await createHarness();
      const turn = h.makeMessage();
      turn.content.text =
        "Read my next saved calendar event. Do not create, edit, or delete anything.";
      h.runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", turn.entityId);
      const final =
        "Your next saved event is QA selected, today from 10:15 to 10:30 AM PDT.";
      let reads = 0;
      h.runtime.registerAction({
        name: "TEST_CALENDAR_READ",
        description: "Read the next saved calendar event",
        contexts: ["general"],
        validate: async () => true,
        handler: async () => {
          reads++;
          return {
            success: true,
            text: JSON.stringify({
              title: "QA selected",
              start: "10:15",
              end: "10:30",
            }),
            transcriptVisibility: "internal",
            modelReplyRequired: true,
            data: { readOnlyOperation: true },
          };
        },
      });
      let responses = 0;
      h.runtime.registerModel(
        ModelType.RESPONSE_HANDLER,
        async () => {
          responses++;
          if (responses > 1) {
            expect(reads).toBe(1);
            return JSON.stringify({
              success: true,
              decision: "FINISH",
              thought: "The current read supplies the event.",
              messageToUser: final,
              replyEffectStatus: "none",
            });
          }
          const response = stage1DirectReply(draft);
          Object.assign(response.toolCalls[0].arguments, {
            contexts: ["general"],
            intents: ["Read the next saved calendar event"],
            candidateActionNames: ["TEST_CALENDAR_READ"],
            requiresTool: true,
            replyEffectStatus: "pending",
          });
          return response;
        },
        "planned-read-proof",
        100,
      );
      h.runtime.registerModel(
        ModelType.ACTION_PLANNER,
        async (_runtime, params) => {
          expect(
            JSON.stringify((params as { tools?: unknown }).tools),
          ).toContain("TEST_CALENDAR_READ");
          return {
            text: "",
            toolCalls: [
              {
                id: "current-read",
                name: "TEST_CALENDAR_READ",
                arguments: { eliza_turn_scope: "final" },
              },
            ],
          };
        },
        "planned-read-proof",
        100,
      );
      const progress: string[] = [];
      const delivered: Content[] = [];
      await h.service.handleMessage(
        h.runtime,
        turn,
        async (content) => {
          delivered.push(content);
          return [];
        },
        {
          onPlanningAcknowledgment: (text) => {
            expect(reads).toBe(0);
            progress.push(text);
          },
        },
      );
      expect(reads).toBe(1);
      expect(progress).toEqual(draft === "Checking that now." ? [draft] : []);
      expect(delivered.map((content) => content.text)).toEqual([final]);
    },
  );
  it.each(
    [ChannelType.DM, ChannelType.VOICE_DM].flatMap((channelType) =>
      (["clean", "private", "revoked", "envelope"] as const).map((kind) => ({
        channelType,
        kind,
      })),
    ),
  )(
    "protects $kind progress on $channelType without consuming final delivery",
    async ({ kind, channelType }) => {
      const h = await createHarness();
      const turn = h.makeMessage();
      turn.content.channelType = channelType;
      h.runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", turn.entityId);
      if (kind === "private" || kind === "revoked") {
        h.runtime.registerProvider({
          name: "userPersonalityPreferences",
          override: true,
          disclosureGate: { require: "owner_exclusive" },
          alwaysInResponseState: true,
          get: async () => ({ text: "PRIVATE_CONTEXT_TEST_VALUE" }),
        });
        await attestDeliveryAudienceFromCanonicalRoom(h.runtime, turn);
      }
      const progressText =
        kind === "envelope"
          ? "Checking <<<EXTERNAL_UNTRUSTED_CONTENT>>> now."
          : kind === "clean"
            ? "Checking that now."
            : "Checking PRIVATE_CONTEXT_TEST_VALUE.";
      h.runtime.registerModel(
        ModelType.RESPONSE_HANDLER,
        async () => {
          if (kind === "revoked")
            await h.runtime.addParticipant(asUUID(v4()), h.roomId);
          const response = stage1DirectReply(progressText);
          Object.assign(response.toolCalls[0].arguments, {
            contexts: ["general"],
            requiresTool: true,
            replyEffectStatus: "pending",
          });
          return response;
        },
        "progress-boundary",
        100,
      );
      h.runtime.registerModel(
        ModelType.ACTION_PLANNER,
        async () =>
          JSON.stringify({
            thought: "The request is resolved.",
            toolCalls: [],
            messageToUser: h.replyText,
          }),
        "progress-boundary",
        100,
      );
      const progress: string[] = [];
      const delivered: Content[] = [];
      await h.service.handleMessage(
        h.runtime,
        turn,
        async (content) => {
          delivered.push(content);
          return [];
        },
        {
          onPlanningAcknowledgment: (text) => {
            progress.push(text);
          },
        },
      );
      expect(progress).toEqual(kind === "clean" ? [progressText] : []);
      expect(delivered).toHaveLength(1);
      if (kind !== "revoked") {
        expect(delivered[0].text).toBe(h.replyText);
        expect(await h.storedReplies()).toHaveLength(1);
      } else
        expect(JSON.stringify(delivered)).not.toContain(
          "PRIVATE_CONTEXT_TEST_VALUE",
        );
    },
  );
});
