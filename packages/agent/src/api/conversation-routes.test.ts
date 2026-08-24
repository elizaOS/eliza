/**
 * Covers the exported conversation-route helpers end to end: chat-turn
 * fingerprint canonicalization, callback-history normalization, persisted
 * assistant-content shaping, pendant provenance verification/stamping, recent
 * callback-history persistence over a real store contract, admin-entity
 * resolution precedence, and handleConversationRoutes dispatch basics.
 * Deterministic unit suite: injected repositories/fake runtimes drive the real
 * module logic — no HTTP server, live model, database, or network.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  deterministicOwnerEntityId,
  ElizaError,
  stringToUuid,
} from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/shared";
import type { PendantSegment } from "@elizaos/shared/contracts/pendant-session-sync";
import { describe, expect, it, vi } from "vitest";
import type { PendantSessionRepository } from "../services/pendant-session/repository.ts";
import {
  buildConversationChatFingerprint,
  buildPersistedAssistantContent,
  type ConversationRouteContext,
  type ConversationRouteState,
  formatConversationMessageText,
  handleConversationRoutes,
  normalizeActionCallbackHistory,
  persistRecentAssistantActionCallbackHistory,
  resolveConversationAdminEntityId,
  serializeMessageAttachments,
  stampCanonicalPendantMemory,
  verifyCanonicalPendantProvenance,
} from "./conversation-routes.ts";
import type { ConversationMeta } from "./server-types.ts";
import type { WaifuChatWorldRole } from "./waifu-chat-role-resolver.ts";

const OWNER_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const AGENT_ID = "22222222-2222-4222-8222-222222222222" as UUID;
const OTHER_AGENT_ID = "33333333-3333-4333-8333-333333333333" as UUID;
const ROOM_ID = "44444444-4444-4444-8444-444444444444" as UUID;
const USER_MESSAGE_ID = "55555555-5555-4555-8555-555555555555" as UUID;
const CONTENT_REPLY_ID = "66666666-6666-4666-8666-666666666666" as UUID;
const MESSAGE_REPLY_ID = "77777777-7777-4777-8777-777777777777" as UUID;
const SESSION_ID = "session-1";
const SEGMENT_ID = "segment-1";
const PENDANT_PROMPT = "capture this thought";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeRouteState(
  overrides: Partial<ConversationRouteState> = {},
): ConversationRouteState {
  const base: ConversationRouteState = {
    runtime: null,
    config: {} as ElizaConfig,
    agentName: "Eliza",
    adminEntityId: null,
    chatUserId: null,
    logBuffer: [],
    conversations: new Map<string, ConversationMeta>(),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set<string>(),
    broadcastWs: null,
  };
  // Declared as the full state so the base is checked in full, then merged and
  // re-asserted: spreading Partial<ConversationRouteState> widens every field
  // it mentions to `T | undefined`, which TS rejects against the required
  // shape (TS2322). vitest does not typecheck, so a green suite misses this.
  return { ...base, ...overrides } as ConversationRouteState;
}

function conversation(
  id: string,
  updatedAt: string,
  roomId: UUID = ROOM_ID,
): ConversationMeta {
  return { id, title: `conv-${id}`, roomId, createdAt: updatedAt, updatedAt };
}

function pendantSegment(
  overrides: Partial<PendantSegment> = {},
): PendantSegment {
  const iso = "2026-08-24T00:00:00.000Z";
  const base: PendantSegment = {
    id: SEGMENT_ID,
    sessionId: SESSION_ID,
    ordinal: 0,
    status: "resolved",
    text: PENDANT_PROMPT,
    words: [],
    speakerCluster: null,
    speakerAlias: null,
    confidence: null,
    error: null,
    createdAt: iso,
    updatedAt: iso,
    startedAt: iso,
    endedAt: null,
    revision: 3,
  };
  return { ...base, ...overrides } as PendantSegment;
}

function repositoryReturning(document: unknown): {
  repository: PendantSessionRepository;
  load: ReturnType<typeof vi.fn>;
} {
  const load = vi.fn(
    async () =>
      document as Awaited<ReturnType<PendantSessionRepository["load"]>>,
  );
  return {
    load,
    repository: { load } as unknown as PendantSessionRepository,
  };
}

function pendantMetadata(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    voiceSource: "pendant",
    pendantOwnerId: OWNER_ID,
    pendantAgentId: AGENT_ID,
    pendantSessionId: SESSION_ID,
    pendantSegmentId: SEGMENT_ID,
    pendantSegmentRevision: 3,
    ...overrides,
  };
}

function pendantRuntime(): AgentRuntime {
  return { agentId: AGENT_ID } as unknown as AgentRuntime;
}

async function capturedError(run: () => Promise<unknown>): Promise<ElizaError> {
  try {
    await run();
  } catch (error) {
    return error as ElizaError;
  }
  throw new Error("expected the call to reject");
}

// ---------------------------------------------------------------------------
// buildConversationChatFingerprint
// ---------------------------------------------------------------------------

describe("module surface", () => {
  it("re-exports the attachment serializer for conversation consumers", () => {
    expect(typeof serializeMessageAttachments).toBe("function");
  });
});

describe("buildConversationChatFingerprint", () => {
  const baseInput = {
    prompt: "hello",
    images: [{ url: "a.png" }],
    source: "web",
    channelType: "local",
    preferredLanguage: "en",
    metadata: { depth: "high", flags: ["voice"] },
  };

  it("produces a stable 64-character lowercase hex digest", () => {
    const digest = buildConversationChatFingerprint(baseInput);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(buildConversationChatFingerprint(baseInput)).toBe(digest);
  });

  it("is invariant under nested object key order", () => {
    const left = buildConversationChatFingerprint({
      ...baseInput,
      metadata: { alpha: 1, beta: { y: 2, x: 3 } },
    });
    const right = buildConversationChatFingerprint({
      ...baseInput,
      metadata: { beta: { x: 3, y: 2 }, alpha: 1 },
    });
    expect(left).toBe(right);
  });

  it("treats array order as significant", () => {
    const left = buildConversationChatFingerprint({
      ...baseInput,
      images: [{ url: "a.png" }, { url: "b.png" }],
    });
    const right = buildConversationChatFingerprint({
      ...baseInput,
      images: [{ url: "b.png" }, { url: "a.png" }],
    });
    expect(left).not.toBe(right);
  });

  it("changes when any input field changes", () => {
    const baseline = buildConversationChatFingerprint(baseInput);
    const mutations = [
      { prompt: "hello!" },
      { images: [] },
      { source: "voice" },
      { channelType: "discord" },
      { preferredLanguage: "de" },
      { metadata: { depth: "low", flags: ["voice"] } },
    ];
    for (const mutation of mutations) {
      const digest = buildConversationChatFingerprint({
        ...baseInput,
        ...mutation,
      });
      expect(digest).not.toBe(baseline);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveConversationAdminEntityId
// ---------------------------------------------------------------------------

describe("resolveConversationAdminEntityId", () => {
  const CACHED_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
  const CONFIGURED_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;

  it("returns a cached admin entity id and mirrors it onto chatUserId", () => {
    const state = makeRouteState({
      adminEntityId: CACHED_ID,
      chatUserId: null,
    });
    expect(resolveConversationAdminEntityId(state)).toBe(CACHED_ID);
    expect(state.chatUserId).toBe(CACHED_ID);
  });

  it("prefers the cached id over the configured default", () => {
    const state = makeRouteState({
      adminEntityId: CACHED_ID,
      config: {
        agents: { defaults: { adminEntityId: CONFIGURED_ID } },
      } as ElizaConfig,
    });
    expect(resolveConversationAdminEntityId(state)).toBe(CACHED_ID);
  });

  it("falls back to the configured agents.defaults.adminEntityId", () => {
    const state = makeRouteState({
      config: {
        agents: { defaults: { adminEntityId: CONFIGURED_ID } },
      } as ElizaConfig,
    });
    expect(resolveConversationAdminEntityId(state)).toBe(CONFIGURED_ID);
    expect(state.adminEntityId).toBe(CONFIGURED_ID);
    expect(state.chatUserId).toBe(CONFIGURED_ID);
  });

  it("seeds deterministically from the agent id when a runtime exists", () => {
    const state = makeRouteState({
      runtime: { agentId: OTHER_AGENT_ID } as unknown as AgentRuntime,
    });
    expect(resolveConversationAdminEntityId(state)).toBe(
      deterministicOwnerEntityId(OTHER_AGENT_ID),
    );
  });

  it("seeds from the agent name only in the degenerate no-runtime case", () => {
    const state = makeRouteState({ agentName: "TestAgent" });
    expect(resolveConversationAdminEntityId(state)).toBe(
      stringToUuid("TestAgent-admin-entity"),
    );
  });
});

// ---------------------------------------------------------------------------
// Callback-history normalization and message formatting
// ---------------------------------------------------------------------------

describe("normalizeActionCallbackHistory", () => {
  it("returns an empty history for non-array input", () => {
    for (const value of [undefined, null, "OPENED CALENDAR", 7, {}]) {
      expect(normalizeActionCallbackHistory(value)).toEqual([]);
    }
  });

  it("trims entries, drops invalid values, and collapses only adjacent duplicates", () => {
    expect(
      normalizeActionCallbackHistory([
        "  OPENED CALENDAR  ",
        "OPENED CALENDAR",
        "",
        "   ",
        "CREATED EVENT",
        "OPENED CALENDAR",
      ]),
    ).toEqual(["OPENED CALENDAR", "CREATED EVENT", "OPENED CALENDAR"]);
  });

  it("is idempotent over an already-normalized history", () => {
    expect(normalizeActionCallbackHistory(["A", "B", "C"])).toEqual([
      "A",
      "B",
      "C",
    ]);
  });
});

describe("formatConversationMessageText", () => {
  it("returns visible text unchanged regardless of history", () => {
    expect(formatConversationMessageText("Here you go", ["A"])).toBe(
      "Here you go",
    );
  });

  it("replaces whitespace-only text with the joined callback history", () => {
    expect(formatConversationMessageText("   \n\t", ["A", "B"])).toBe("A\nB");
  });

  it("normalizes the history before joining", () => {
    expect(formatConversationMessageText("", ["  A ", "A", " B"])).toBe("A\nB");
  });

  it("returns the original text when the normalized history is empty", () => {
    expect(formatConversationMessageText("", [])).toBe("");
    expect(formatConversationMessageText("untouched", [])).toBe("untouched");
  });
});

// ---------------------------------------------------------------------------
// buildPersistedAssistantContent
// ---------------------------------------------------------------------------

describe("buildPersistedAssistantContent", () => {
  it("persists bare text when there is no generation result", () => {
    expect(buildPersistedAssistantContent("hello", null)).toEqual({
      text: "hello",
    });
    expect(buildPersistedAssistantContent("hello", undefined)).toEqual({
      text: "hello",
    });
  });

  it("attaches the explicit user message id as inReplyTo", () => {
    expect(buildPersistedAssistantContent("hi", null, USER_MESSAGE_ID)).toEqual(
      { text: "hi", inReplyTo: USER_MESSAGE_ID },
    );
  });

  it("uses the last valid response-message content as the base", () => {
    const content = buildPersistedAssistantContent("final", {
      responseMessages: [
        { id: "m1", content: { text: "stale" } },
        { id: "m2" },
        { id: "m3", content: { text: "newest", origin: "message" } },
      ],
    });
    expect(content).toEqual({ text: "final", origin: "message" });
  });

  it("lets responseContent override the message base while text wins overall", () => {
    const content = buildPersistedAssistantContent("final", {
      responseMessages: [{ content: { shared: "from-message", only: "m" } }],
      responseContent: { shared: "from-content", extra: true },
    });
    expect(content).toEqual({
      shared: "from-content",
      only: "m",
      extra: true,
      text: "final",
    });
  });

  it("ranks inReplyTo: explicit user id, then responseContent, then response message", () => {
    const explicit = buildPersistedAssistantContent(
      "t",
      {
        responseContent: { inReplyTo: CONTENT_REPLY_ID },
        responseMessages: [{ content: { inReplyTo: MESSAGE_REPLY_ID } }],
      },
      USER_MESSAGE_ID,
    );
    expect(explicit.inReplyTo).toBe(USER_MESSAGE_ID);

    const fromContent = buildPersistedAssistantContent("t", {
      responseContent: { inReplyTo: CONTENT_REPLY_ID },
      responseMessages: [{ content: { inReplyTo: MESSAGE_REPLY_ID } }],
    });
    expect(fromContent.inReplyTo).toBe(CONTENT_REPLY_ID);

    const fromMessage = buildPersistedAssistantContent("t", {
      responseMessages: [{ content: { inReplyTo: MESSAGE_REPLY_ID } }],
    });
    expect(fromMessage.inReplyTo).toBe(MESSAGE_REPLY_ID);
  });

  it("strips untrusted embedded transcriptVisibility and honors only the explicit internal flag", () => {
    const stripped = buildPersistedAssistantContent("t", {
      responseContent: { transcriptVisibility: "internal", note: "kept" },
      responseMessages: [{ content: { transcriptVisibility: "internal" } }],
    });
    expect(stripped.transcriptVisibility).toBeUndefined();
    expect(stripped.note).toBe("kept");

    const flagged = buildPersistedAssistantContent("t", {
      responseContent: { transcriptVisibility: "internal" },
      transcriptVisibility: "internal",
    });
    expect(flagged.transcriptVisibility).toBe("internal");
  });

  it("normalizes the action callback history and omits it when empty", () => {
    const normalized = buildPersistedAssistantContent("t", {
      actionCallbackHistory: ["  A ", "A", "   ", "B"],
    });
    expect(normalized.actionCallbackHistory).toEqual(["A", "B"]);

    const empty = buildPersistedAssistantContent("t", {
      actionCallbackHistory: [],
    });
    expect(empty).toEqual({ text: "t" });
    expect("actionCallbackHistory" in empty).toBe(false);
  });

  it("falls back to the text-plus-history shape without any response content", () => {
    expect(
      buildPersistedAssistantContent("", { actionCallbackHistory: ["A"] }),
    ).toEqual({ text: "", actionCallbackHistory: ["A"] });
  });
});

// ---------------------------------------------------------------------------
// verifyCanonicalPendantProvenance
// ---------------------------------------------------------------------------

describe("verifyCanonicalPendantProvenance", () => {
  const caller = { entityId: OWNER_ID, role: "OWNER" } as {
    entityId: UUID;
    role: WaifuChatWorldRole;
  };

  it("returns null without touching any repository for non-pendant turns", async () => {
    const { repository, load } = repositoryReturning(null);
    for (const metadata of [undefined, {}, { voiceSource: "keyboard" }]) {
      expect(
        await verifyCanonicalPendantProvenance(
          pendantRuntime(),
          caller,
          PENDANT_PROMPT,
          metadata,
          repository,
        ),
      ).toBeNull();
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("requires the authenticated owner to submit a pendant transcript", async () => {
    const { repository } = repositoryReturning(null);
    const error = await capturedError(() =>
      verifyCanonicalPendantProvenance(
        pendantRuntime(),
        { entityId: OWNER_ID, role: "USER" },
        PENDANT_PROMPT,
        pendantMetadata(),
        repository,
      ),
    );
    expect(error).toBeInstanceOf(ElizaError);
    expect(error.code).toBe("PENDANT_TRANSCRIPT_OWNER_REQUIRED");
  });

  it("rejects missing or blank provenance strings with the offending key", async () => {
    const { repository } = repositoryReturning(null);
    for (const [key, value] of [
      ["pendantOwnerId", undefined],
      ["pendantOwnerId", "   "],
      ["pendantAgentId", undefined],
      ["pendantSessionId", ""],
      ["pendantSegmentId", null],
    ] as const) {
      const error = await capturedError(() =>
        verifyCanonicalPendantProvenance(
          pendantRuntime(),
          caller,
          PENDANT_PROMPT,
          pendantMetadata({ [key]: value }),
          repository,
        ),
      );
      expect(error.code).toBe("PENDANT_TRANSCRIPT_PROVENANCE_INVALID");
      expect(error.context).toEqual({ key });
    }
  });

  it("rejects unsafe or fractional segment revisions", async () => {
    const { repository } = repositoryReturning(null);
    for (const revision of [-1, 1.5, Number.NaN, "3", null]) {
      const error = await capturedError(() =>
        verifyCanonicalPendantProvenance(
          pendantRuntime(),
          caller,
          PENDANT_PROMPT,
          pendantMetadata({ pendantSegmentRevision: revision }),
          repository,
        ),
      );
      expect(error.code).toBe("PENDANT_TRANSCRIPT_PROVENANCE_INVALID");
      expect(error.context).toEqual({ key: "pendantSegmentRevision" });
    }
    expect(repositoryReturning(null).load).not.toHaveBeenCalled();
  });

  it("rejects identities that do not match the caller or the runtime", async () => {
    const { repository } = repositoryReturning(null);
    const foreignOwner = await capturedError(() =>
      verifyCanonicalPendantProvenance(
        pendantRuntime(),
        caller,
        PENDANT_PROMPT,
        pendantMetadata({ pendantOwnerId: OTHER_AGENT_ID }),
        repository,
      ),
    );
    expect(foreignOwner.code).toBe("PENDANT_TRANSCRIPT_IDENTITY_MISMATCH");

    const foreignAgent = await capturedError(() =>
      verifyCanonicalPendantProvenance(
        { agentId: OTHER_AGENT_ID } as unknown as AgentRuntime,
        caller,
        PENDANT_PROMPT,
        pendantMetadata(),
        repository,
      ),
    );
    expect(foreignAgent.code).toBe("PENDANT_TRANSCRIPT_IDENTITY_MISMATCH");
  });

  it("rejects sessions or segments that fail canonical matching", async () => {
    const mismatchCases = [
      null,
      { segments: [] },
      { segments: [pendantSegment({ sessionId: "other-session" })] },
      { segments: [pendantSegment({ status: "pending" })] },
      { segments: [pendantSegment({ revision: 4 })] },
      { segments: [pendantSegment({ text: "different thought" })] },
      { segments: [pendantSegment({ id: "segment-2" })] },
    ];
    for (const document of mismatchCases) {
      const { repository } = repositoryReturning(document);
      const error = await capturedError(() =>
        verifyCanonicalPendantProvenance(
          pendantRuntime(),
          caller,
          PENDANT_PROMPT,
          pendantMetadata(),
          repository,
        ),
      );
      expect(error.code).toBe("PENDANT_TRANSCRIPT_SEGMENT_MISMATCH");
      expect(error.context).toEqual({
        sessionId: SESSION_ID,
        segmentId: SEGMENT_ID,
        segmentRevision: 3,
      });
    }
  });

  it("resolves the provenance for a matching resolved segment and looks it up exactly once", async () => {
    const { repository, load } = repositoryReturning({
      segments: [pendantSegment()],
    });
    const provenance = await verifyCanonicalPendantProvenance(
      pendantRuntime(),
      caller,
      `  ${PENDANT_PROMPT}  `,
      pendantMetadata(),
      repository,
    );
    expect(provenance).toEqual({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      segmentId: SEGMENT_ID,
      segmentRevision: 3,
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
    });
  });
});

// ---------------------------------------------------------------------------
// stampCanonicalPendantMemory
// ---------------------------------------------------------------------------

describe("stampCanonicalPendantMemory", () => {
  it("stamps both persisted memories with identical owner-private pendant metadata", () => {
    const provenance = {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      segmentId: SEGMENT_ID,
      segmentRevision: 3,
    };
    const userMessage = {
      id: USER_MESSAGE_ID,
      metadata: { preExisting: "keep" },
    } as unknown as Memory;
    const messageToStore = { id: USER_MESSAGE_ID } as unknown as Memory;

    stampCanonicalPendantMemory(
      { userMessage, messageToStore } as Parameters<
        typeof stampCanonicalPendantMemory
      >[0],
      provenance,
    );

    const sharedStamp = {
      type: "message",
      provider: "pendant",
      accountId: AGENT_ID,
      platformMessageId: SEGMENT_ID,
      sourceId: SEGMENT_ID,
      chatType: "dm",
      scope: "owner-private",
      scopedToEntityId: OWNER_ID,
      addedBy: OWNER_ID,
      addedByRole: "OWNER",
      base: { type: "message", source: "pendant", scope: "owner-private" },
      pendant: {
        userId: OWNER_ID,
        accountId: AGENT_ID,
        messageId: SEGMENT_ID,
        sessionId: SESSION_ID,
        segmentId: SEGMENT_ID,
        segmentRevision: 3,
      },
    };
    for (const memory of [userMessage, messageToStore]) {
      expect(memory.metadata).toMatchObject(sharedStamp);
    }
    expect(
      (userMessage.metadata as Record<string, unknown> | undefined)
        ?.preExisting,
    ).toBe("keep");
  });
});

// ---------------------------------------------------------------------------
// persistRecentAssistantActionCallbackHistory
// ---------------------------------------------------------------------------

function assistantMemory(overrides: {
  id: UUID;
  createdAt?: number;
  roomId?: UUID;
  entityId?: UUID;
  agentId?: UUID;
  text?: string;
  history?: string[];
}): Memory {
  return {
    id: overrides.id,
    entityId: overrides.entityId ?? AGENT_ID,
    agentId: overrides.agentId ?? AGENT_ID,
    roomId: overrides.roomId ?? ROOM_ID,
    createdAt: overrides.createdAt,
    content: {
      text: overrides.text ?? "done",
      ...(overrides.history
        ? { actionCallbackHistory: overrides.history }
        : {}),
    },
  } as Memory;
}

function makePersistRuntime(options: {
  memories?: Memory[];
  ownsCurrentLease?: boolean;
}): {
  runtime: AgentRuntime;
  getMemories: ReturnType<typeof vi.fn>;
  getMemoriesByIds: ReturnType<typeof vi.fn>;
  updateMemory: ReturnType<typeof vi.fn>;
  ownsLease: ReturnType<typeof vi.fn>;
  runInLease: ReturnType<typeof vi.fn>;
  withLease: ReturnType<typeof vi.fn>;
} {
  const acquiredLease = { token: "acquired" };
  const getMemories = vi.fn(async () => options.memories ?? []);
  const getMemoriesByIds = vi.fn(async () => options.memories ?? []);
  const updateMemory = vi.fn(async () => undefined);
  const ownsLease = vi.fn(() => options.ownsCurrentLease ?? false);
  const runInLease = vi.fn(
    (_roomId: UUID, _lease: unknown, task: () => unknown) => task(),
  );
  const withLease = vi.fn((_roomId: UUID, task: (lease: unknown) => unknown) =>
    task(acquiredLease),
  );
  const runtime = {
    agentId: AGENT_ID,
    getMemories,
    getMemoriesByIds,
    updateMemory,
    roomHandlerQueue: { ownsLease, runInLease, withLease },
  };
  return {
    runtime: runtime as unknown as AgentRuntime,
    getMemories,
    getMemoriesByIds,
    updateMemory,
    ownsLease,
    runInLease,
    withLease,
  };
}

describe("persistRecentAssistantActionCallbackHistory", () => {
  it("returns false without touching stores or leases for an empty history", async () => {
    const helpers = makePersistRuntime({});
    const updated = await persistRecentAssistantActionCallbackHistory(
      helpers.runtime,
      ROOM_ID,
      ["   ", ""],
      Date.now(),
    );
    expect(updated).toBe(false);
    expect(helpers.getMemories).not.toHaveBeenCalled();
    expect(helpers.getMemoriesByIds).not.toHaveBeenCalled();
    expect(helpers.updateMemory).not.toHaveBeenCalled();
    expect(helpers.ownsLease).not.toHaveBeenCalled();
  });

  it("updates only the newest eligible assistant memory within the recency window", async () => {
    const sinceMs = 10_000;
    const older = assistantMemory({
      id: "88888888-8888-4888-8888-888888888888" as UUID,
      createdAt: 7_999,
    });
    const mid = assistantMemory({
      id: "99999999-9999-4999-8999-999999999999" as UUID,
      createdAt: 8_000,
      history: ["EARLIER"],
    });
    const newest = assistantMemory({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab" as UUID,
      createdAt: 9_500,
    });
    const helpers = makePersistRuntime({
      memories: [older, newest, mid],
    });

    const updated = await persistRecentAssistantActionCallbackHistory(
      helpers.runtime,
      ROOM_ID,
      ["LATEST"],
      sinceMs,
    );

    expect(updated).toBe(true);
    expect(helpers.updateMemory).toHaveBeenCalledTimes(1);
    const [patch] = helpers.updateMemory.mock.calls[0] as Array<{
      id: UUID;
      content: { actionCallbackHistory?: string[] };
    }>;
    expect(patch.id).toBe(newest.id);
    expect(patch.content.actionCallbackHistory).toEqual(["LATEST"]);
  });

  it("merges into existing history preserving non-adjacent entries", async () => {
    const target = assistantMemory({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID,
      createdAt: 9_000,
      history: ["A", "B"],
    });
    const helpers = makePersistRuntime({ memories: [target] });
    const updated = await persistRecentAssistantActionCallbackHistory(
      helpers.runtime,
      ROOM_ID,
      ["B", "C"],
      10_000,
    );
    expect(updated).toBe(true);
    const [patch] = helpers.updateMemory.mock.calls[0] as Array<{
      content: { actionCallbackHistory?: string[] };
    }>;
    expect(patch.content.actionCallbackHistory).toEqual(["A", "B", "C"]);
  });

  it("skips the write when the merge would not change anything", async () => {
    const target = assistantMemory({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as UUID,
      createdAt: 9_000,
      history: ["A"],
    });
    const helpers = makePersistRuntime({ memories: [target] });
    const updated = await persistRecentAssistantActionCallbackHistory(
      helpers.runtime,
      ROOM_ID,
      ["A"],
      10_000,
    );
    expect(updated).toBe(true);
    expect(helpers.updateMemory).not.toHaveBeenCalled();
  });

  it("ignores memories outside the room, the assistant identity, or with blank text", async () => {
    const decoys = [
      assistantMemory({
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" as UUID,
        roomId: "ffff0000-0000-4000-8000-000000000001" as UUID,
      }),
      assistantMemory({
        id: "ffff0000-0000-4000-8000-000000000002" as UUID,
        entityId: OWNER_ID,
      }),
      assistantMemory({
        id: "ffff0000-0000-4000-8000-000000000003" as UUID,
        text: "   ",
      }),
    ];
    const helpers = makePersistRuntime({ memories: decoys });
    const updated = await persistRecentAssistantActionCallbackHistory(
      helpers.runtime,
      ROOM_ID,
      ["A"],
      Date.now(),
    );
    expect(updated).toBe(false);
    expect(helpers.updateMemory).not.toHaveBeenCalled();
  });

  it("looks up an exact target memory by id when one is supplied", async () => {
    const target = assistantMemory({
      id: "abcdef00-1234-4000-8000-000000000001" as UUID,
      history: ["OLD"],
    });
    const helpers = makePersistRuntime({ memories: [target] });
    const updated = await persistRecentAssistantActionCallbackHistory(
      helpers.runtime,
      ROOM_ID,
      ["NEW"],
      0,
      target.id,
    );
    expect(updated).toBe(true);
    expect(helpers.getMemoriesByIds).toHaveBeenCalledWith(
      [target.id],
      "messages",
    );
    expect(helpers.getMemories).not.toHaveBeenCalled();
    const [patch] = helpers.updateMemory.mock.calls[0] as Array<{
      id: UUID;
      content: { actionCallbackHistory?: string[] };
    }>;
    expect(patch.id).toBe(target.id);
    expect(patch.content.actionCallbackHistory).toEqual(["OLD", "NEW"]);
  });

  it("wraps a missing exact target as CONVERSATION_CALLBACK_HISTORY_WRITE_FAILED", async () => {
    const helpers = makePersistRuntime({
      memories: [
        assistantMemory({
          id: "abcdef00-1234-4000-8000-000000000002" as UUID,
          text: "   ",
        }),
      ],
    });
    const error = await capturedError(() =>
      persistRecentAssistantActionCallbackHistory(
        helpers.runtime,
        ROOM_ID,
        ["A"],
        0,
        "abcdef00-1234-4000-8000-000000000099" as UUID,
      ),
    );
    expect(error).toBeInstanceOf(ElizaError);
    expect(error.code).toBe("CONVERSATION_CALLBACK_HISTORY_WRITE_FAILED");
    expect((error.cause as ElizaError | undefined)?.code).toBe(
      "CONVERSATION_CALLBACK_TARGET_NOT_FOUND",
    );
  });

  it("runs inside the caller's lease when it still owns the room lease", async () => {
    const target = assistantMemory({
      id: "abcdef00-1234-4000-8000-000000000004" as UUID,
    });
    const helpers = makePersistRuntime({
      memories: [target],
      ownsCurrentLease: true,
    });
    const lease = { token: "caller-lease" };
    const updated = await persistRecentAssistantActionCallbackHistory(
      helpers.runtime,
      ROOM_ID,
      ["A"],
      0,
      undefined,
      lease as never,
    );
    expect(updated).toBe(true);
    expect(helpers.ownsLease).toHaveBeenCalledWith(ROOM_ID, lease);
    expect(helpers.withLease).not.toHaveBeenCalled();
    expect(helpers.runInLease).toHaveBeenCalledWith(
      ROOM_ID,
      lease,
      expect.any(Function),
    );
  });

  it("acquires a fresh lease when none is held", async () => {
    const target = assistantMemory({
      id: "abcdef00-1234-4000-8000-000000000005" as UUID,
    });
    const helpers = makePersistRuntime({ memories: [target] });
    await persistRecentAssistantActionCallbackHistory(
      helpers.runtime,
      ROOM_ID,
      ["A"],
      0,
    );
    expect(helpers.withLease).toHaveBeenCalledTimes(1);
    expect(helpers.runInLease).toHaveBeenCalledWith(
      ROOM_ID,
      { token: "acquired" },
      expect.any(Function),
    );
  });
});

// ---------------------------------------------------------------------------
// handleConversationRoutes dispatch
// ---------------------------------------------------------------------------

function makeRouteContext(options: {
  method: string;
  pathname: string;
  url?: string;
  state: ConversationRouteState;
}): {
  ctx: ConversationRouteContext;
  jsonBody: () => { data: unknown; status?: number } | undefined;
  errorBody: () => { message: string; status?: number } | undefined;
} {
  const jsonCalls: Array<{ data: unknown; status?: number }> = [];
  const errorCalls: Array<{ message: string; status?: number }> = [];
  const ctx: ConversationRouteContext = {
    req: {
      url: options.url ?? options.pathname,
      headers: {},
    } as unknown as IncomingMessage,
    res: {} as ServerResponse,
    method: options.method,
    pathname: options.pathname,
    readJsonBody: async () => null,
    json: (_res, data, status) => {
      jsonCalls.push({ data, status });
    },
    error: (_res, message, status) => {
      errorCalls.push({ message, status });
    },
    state: options.state,
  };
  return {
    ctx,
    jsonBody: () => jsonCalls.at(-1),
    errorBody: () => errorCalls.at(-1),
  };
}

describe("handleConversationRoutes dispatch", () => {
  it("declines paths outside the conversation surface without responding", async () => {
    const context = makeRouteContext({
      method: "GET",
      pathname: "/api/health",
      state: makeRouteState(),
    });
    const handled = await handleConversationRoutes(context.ctx);
    expect(handled).toBe(false);
    expect(context.jsonBody()).toBeUndefined();
    expect(context.errorBody()).toBeUndefined();
  });

  it("serves an empty conversation list for a fresh agent", async () => {
    const context = makeRouteContext({
      method: "GET",
      pathname: "/api/conversations",
      state: makeRouteState({
        conversationRestorePromise: Promise.resolve(),
      }),
    });
    const handled = await handleConversationRoutes(context.ctx);
    expect(handled).toBe(true);
    expect(context.jsonBody()).toEqual({ data: { conversations: [] } });
    expect(context.errorBody()).toBeUndefined();
  });

  it("excludes tombstoned conversations and orders the rest newest-updated first", async () => {
    const state = makeRouteState({
      conversations: new Map(
        [
          conversation("old", "2026-01-01T00:00:00.000Z"),
          conversation("new", "2026-03-01T00:00:00.000Z"),
          conversation("gone", "2026-06-01T00:00:00.000Z"),
        ].map((meta) => [meta.id, meta]),
      ),
      deletedConversationIds: new Set(["gone"]),
    });
    const context = makeRouteContext({
      method: "GET",
      pathname: "/api/conversations",
      state,
    });
    const handled = await handleConversationRoutes(context.ctx);
    expect(handled).toBe(true);
    const body = context.jsonBody()?.data as {
      conversations: Array<{ id: string }>;
    };
    expect(body.conversations.map((entry) => entry.id)).toEqual(["new", "old"]);
  });

  it("answers corpus search with an empty result set before a runtime exists", async () => {
    const context = makeRouteContext({
      method: "GET",
      pathname: "/api/conversations/messages/search",
      url: "/api/conversations/messages/search?q=find%20me",
      state: makeRouteState(),
    });
    const handled = await handleConversationRoutes(context.ctx);
    expect(handled).toBe(true);
    expect(context.jsonBody()).toEqual({ data: { results: [], count: 0 } });
  });

  it("rejects search queries shorter than two characters with a 400", async () => {
    const context = makeRouteContext({
      method: "GET",
      pathname: "/api/conversations/messages/search",
      url: "/api/conversations/messages/search?q=h",
      state: makeRouteState({
        runtime: {} as unknown as AgentRuntime,
      }),
    });
    const handled = await handleConversationRoutes(context.ctx);
    expect(handled).toBe(true);
    expect(context.errorBody()).toEqual({
      message: "Search query must be at least 2 characters",
      status: 400,
    });
    expect(context.jsonBody()).toBeUndefined();
  });
});
