/**
 * PROBE (P5 voice gateway): does a voice turn land in the SAME shared-runtime
 * memory that text chat reads?
 *
 * This drives the REAL live path — `elizaSandboxService.bridgeStream` on a
 * `shared` tier sandbox → `bridgeSharedMessageStream` → `saveSharedRuntimeHistory`
 * — and then reads back through the REAL text-chat read path
 * (`getSharedConversationHistory`, which is what `sharedRestMessagesGet` calls).
 *
 * It is a probe, not a fixture of the thing under test: only the model stream,
 * the sandbox row, and billing are stubbed. Channel-id derivation, history
 * load/save, and the SSE framing are the production code.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

// `@elizaos/core` resolves through plugin-sql's unbuilt workspace `dist` in a
// fresh worktree (an environmental constraint, not a product one — the untouched
// sibling suite `eliza-sandbox-shared-billing.test.ts` fails identically here).
// eliza-sandbox.ts only needs the `ElizaError` symbol, so stub that one export.
mock.module("@elizaos/core", () => ({
  ElizaError: class ElizaError extends Error {},
  // `lib/utils/logger` pulls these two in; the probe asserts on persistence, not
  // on log redaction, so identity/no-op implementations are faithful enough.
  isSensitiveKeyName: () => false,
  redactLogArgs: (...args: unknown[]) => args,
}));
// `db/schemas/eliza.ts` re-exports the plugin-sql Drizzle tables, which drags in
// the unbuilt `@elizaos/plugin-sql` workspace package. This probe never touches
// those tables (history goes through the mocked repository below), so an empty
// schema module is sufficient and keeps the probe hermetic.
mock.module("@elizaos/plugin-sql", () => ({}));
// `buildSharedRuntimeCharacter` looks up the linked character row. There is no
// Postgres in this probe, so serve the character from memory; the sandbox row
// below already carries the identity the assertions care about.
mock.module("../../db/repositories/characters", () => ({
  userCharactersRepository: {
    findByIdInOrganization: async () => undefined,
  },
}));

import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";

// Every real module is loaded with `await import` AFTER the `mock.module` calls
// above: static ESM imports are hoisted, so a static import here would evaluate
// the real dependency graph before the stubs are installed.
const { agentSandboxesRepository } = await import("../../db/repositories/agent-sandboxes");
const { runWithCloudBindings } = await import("../runtime/cloud-bindings");

const realRunSharedAgentTurnNs = await import("./shared-runtime/run-shared-agent-turn");
const realRunSharedAgentTurn = { ...realRunSharedAgentTurnNs };

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const ROOM_ID = "44444444-4444-4444-8444-444444444444";

const sandboxRow = {
  id: AGENT_ID,
  organization_id: ORG_ID,
  user_id: USER_ID,
  execution_tier: "shared",
  status: "running",
  agent_name: "Soliza",
  character_id: "55555555-5555-4555-8555-555555555555",
} as unknown as AgentSandbox;

/** In-memory stand-in for the durable shared-runtime history table. */
const historyStore = new Map<string, unknown[]>();
const historyKey = (agentId: string, channelId: string) => `${agentId}::${channelId}`;

/** Deltas the stubbed model emits, then a `finish` part. */
let scriptedDeltas: string[] = [];
/** If set, the stream throws after emitting this many deltas (mid-stream drop). */
let throwAfterDeltas: number | null = null;

beforeAll(() => {
  mock.module("../../db/repositories/shared-runtime-history", () => ({
    sharedRuntimeHistoryRepository: {
      get: async (agentId: string, channelId: string) =>
        historyStore.get(historyKey(agentId, channelId)) ?? [],
      upsert: async (agentId: string, channelId: string, history: unknown[]) => {
        historyStore.set(historyKey(agentId, channelId), history);
      },
    },
  }));

  mock.module("./shared-runtime/run-shared-agent-turn", () => ({
    ...realRunSharedAgentTurn,
    // Keep the REAL model resolver returning null so no billing context is
    // built; this probe is about persistence, not metering.
    resolveSharedAgentTurnModel: () => null,
    runSharedAgentTurnStream: async () => {
      const deltas = [...scriptedDeltas];
      const limit = throwAfterDeltas;
      const parts = (async function* () {
        let emitted = 0;
        for (const text of deltas) {
          yield { type: "text-delta" as const, text };
          emitted += 1;
          if (limit !== null && emitted >= limit) {
            throw new Error("upstream stream dropped");
          }
        }
        yield { type: "finish" as const, text: deltas.join("") };
      })();
      return { model: "probe-model", degraded: false, reply: deltas.join(""), parts };
    },
  }));
});

afterAll(() => {
  mock.module("./shared-runtime/run-shared-agent-turn", () => realRunSharedAgentTurn);
});

const { elizaSandboxService } = await import("./eliza-sandbox");

function voiceRpc(text: string, roomId: string) {
  return {
    jsonrpc: "2.0" as const,
    id: crypto.randomUUID(),
    method: "message.send",
    params: { text, roomId, userId: USER_ID, source: "voice" },
  };
}

/** Drain an SSE Response body to completion so the stream's `start` finishes. */
async function drain(res: Response | null): Promise<string> {
  if (!res?.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    out += decoder.decode(chunk.value, { stream: true });
  }
  return out + decoder.decode();
}

/**
 * Read back through the SAME accessor the text-chat REST adapter uses
 * (`sharedRestMessagesGet` → `getSharedConversationHistory`).
 */
async function readTextChatHistory(roomId: string) {
  return elizaSandboxService.getSharedConversationHistory(AGENT_ID, roomId);
}

let findRunningSandbox: ReturnType<typeof mock>;

beforeEach(() => {
  historyStore.clear();
  scriptedDeltas = [];
  throwAfterDeltas = null;
  findRunningSandbox = mock(async () => sandboxRow);
  (agentSandboxesRepository as unknown as { findRunningSandbox: unknown }).findRunningSandbox =
    findRunningSandbox;
});

const withBindings = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithCloudBindings({} as Record<string, unknown>, fn);

describe("P5 probe: voice turns share memory with text chat", () => {
  test("a COMPLETED voice turn is readable through the text-chat history accessor", async () => {
    scriptedDeltas = ["Your ", "flight ", "is ", "at ", "6pm."];

    await withBindings(async () => {
      const res = await elizaSandboxService.bridgeStream(
        AGENT_ID,
        ORG_ID,
        voiceRpc("when is my flight?", ROOM_ID),
      );
      await drain(res);
    });

    const history = await withBindings(() => readTextChatHistory(ROOM_ID));

    // This is the P5 "same memory" claim: the voice turn is visible to text chat.
    expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(history[0].content).toBe("when is my flight?");
    expect(history[1].content).toBe("Your flight is at 6pm.");
  });

  test("voice turn 2 sees voice turn 1 (multi-turn context on one room)", async () => {
    scriptedDeltas = ["Noted."];
    await withBindings(async () => {
      await drain(
        await elizaSandboxService.bridgeStream(
          AGENT_ID,
          ORG_ID,
          voiceRpc("call me Shadow", ROOM_ID),
        ),
      );
    });

    scriptedDeltas = ["Shadow."];
    await withBindings(async () => {
      await drain(
        await elizaSandboxService.bridgeStream(
          AGENT_ID,
          ORG_ID,
          voiceRpc("what is my name?", ROOM_ID),
        ),
      );
    });

    const history = await withBindings(() => readTextChatHistory(ROOM_ID));
    expect(history.map((m) => m.content)).toEqual([
      "call me Shadow",
      "Noted.",
      "what is my name?",
      "Shadow.",
    ]);
  });

  test("a BARGE-IN (consumer cancels mid-stream) still persists the user's utterance", async () => {
    // Faithful barge-in shape: the voice session aborts its SSE fetch, which
    // cancels this response body while the agent is still speaking.
    scriptedDeltas = ["Your flight ", "is at ", "6pm."];

    await withBindings(async () => {
      const res = await elizaSandboxService.bridgeStream(
        AGENT_ID,
        ORG_ID,
        voiceRpc("when is my flight?", ROOM_ID),
      );
      const reader = res?.body?.getReader();
      // Read one chunk (the user heard the beginning of the reply) then cancel,
      // exactly as `interrupt()` -> `llmAbort.abort()` does upstream.
      await reader?.read();
      await reader?.cancel("barge-in");
    });

    // Let any queued microtasks from the cancelled stream settle.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const history = await withBindings(() => readTextChatHistory(ROOM_ID));

    // The human's spoken turn survives the interruption, so the next turn (voice
    // or typed) knows the exchange happened.
    expect(history[0]).toMatchObject({ role: "user", content: "when is my flight?" });
    // The partial reply is kept, but explicitly marked so it is never mistaken
    // for something the agent finished saying.
    expect(history[1]).toMatchObject({ role: "assistant", interrupted: true });
    // A prefix of the reply, not the whole thing: how many deltas land before
    // the cancel is a scheduling detail, so assert the prefix relation rather
    // than an exact cut point.
    expect("Your flight is at 6pm.".startsWith(history[1].content)).toBe(true);
    expect(history[1].content.endsWith("6pm.")).toBe(false);
  });

  test("an upstream stream drop still persists the user's utterance", async () => {
    scriptedDeltas = ["Your flight ", "is at ", "6pm."];
    // Drop the upstream stream after the first delta — this is what a barge-in
    // (abort) or a transport drop looks like to `bridgeSharedMessageStream`.
    throwAfterDeltas = 1;

    await withBindings(async () => {
      const res = await elizaSandboxService.bridgeStream(
        AGENT_ID,
        ORG_ID,
        voiceRpc("when is my flight?", ROOM_ID),
      );
      const body = await drain(res);
      // The client DID receive partial spoken content.
      expect(body).toContain("Your flight ");
      expect(body).toContain("event: error");
    });

    const history = await withBindings(() => readTextChatHistory(ROOM_ID));

    expect(history[0]).toMatchObject({ role: "user", content: "when is my flight?" });
    expect(history[1]).toMatchObject({
      role: "assistant",
      content: "Your flight",
      interrupted: true,
    });
  });

  test("an interrupted turn is visible to the NEXT turn's context (no silent amnesia)", async () => {
    scriptedDeltas = ["Your flight ", "is at ", "6pm."];
    throwAfterDeltas = 1;
    await withBindings(async () => {
      await drain(
        await elizaSandboxService.bridgeStream(
          AGENT_ID,
          ORG_ID,
          voiceRpc("when is my flight?", ROOM_ID),
        ),
      );
    });

    // The next turn loads history through the production path, so the
    // interrupted exchange is part of the model's context rather than lost.
    throwAfterDeltas = null;
    scriptedDeltas = ["6pm, as I said."];
    await withBindings(async () => {
      await drain(
        await elizaSandboxService.bridgeStream(
          AGENT_ID,
          ORG_ID,
          voiceRpc("sorry, repeat?", ROOM_ID),
        ),
      );
    });

    const history = await withBindings(() => readTextChatHistory(ROOM_ID));
    expect(history.map((m) => m.content)).toEqual([
      "when is my flight?",
      "Your flight",
      "sorry, repeat?",
      "6pm, as I said.",
    ]);
    // Only the cut-short turn carries the flag.
    expect(history.map((m) => Boolean(m.interrupted))).toEqual([false, true, false, false]);
  });

  test("a turn is never persisted twice when completion races the interrupt path", async () => {
    scriptedDeltas = ["All done."];
    await withBindings(async () => {
      await drain(
        await elizaSandboxService.bridgeStream(AGENT_ID, ORG_ID, voiceRpc("status?", ROOM_ID)),
      );
    });
    const history = await withBindings(() => readTextChatHistory(ROOM_ID));
    expect(history).toHaveLength(2);
    expect(history.map((m) => Boolean(m.interrupted))).toEqual([false, false]);
  });
});
