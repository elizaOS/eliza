/**
 * Real-PGlite proof that conversation idempotency survives a runtime restart.
 * The deterministic message service isolates admission/persistence semantics
 * while the production route and database adapter remain real.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  type AgentRuntime,
  createUniqueUuid,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetChatDedupeForTests } from "../../../agent/src/api/chat-routes.ts";
import {
  type ConversationRouteContext,
  type ConversationRouteState,
  handleConversationRoutes,
} from "../../../agent/src/api/conversation-routes.ts";
import type { ConversationMeta } from "../../../agent/src/api/server-types.ts";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../helpers/real-runtime.ts";

const CHARACTER_NAME = "Conversation Idempotency Restart Agent";
const CONVERSATION_ID = "pglite-restart-conversation";
const ROOM_ID = stringToUuid("pglite-restart-room") as UUID;
const OWNER_ID = stringToUuid("pglite-restart-owner") as UUID;
const MESSAGE_PATH = `/api/conversations/${CONVERSATION_ID}/messages`;

interface RouteResult {
  body: Record<string, unknown>;
  status: number;
}

function createConversation(): ConversationMeta {
  const createdAt = new Date(1_786_200_000_000).toISOString();
  return {
    id: CONVERSATION_ID,
    title: "PGlite restart idempotency",
    roomId: ROOM_ID,
    createdAt,
    updatedAt: createdAt,
  };
}

function createState(runtime: AgentRuntime): ConversationRouteState {
  const conversation = createConversation();
  return {
    runtime,
    config: { user: { name: "PGlite tester" } } as never,
    agentName: CHARACTER_NAME,
    adminEntityId: OWNER_ID,
    chatUserId: OWNER_ID,
    logBuffer: [],
    conversations: new Map([[conversation.id, conversation]]),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set<string>(),
    broadcastWs: null,
  } as ConversationRouteState;
}

function installDeterministicMessageService(
  runtime: AgentRuntime,
  handledPrompts: string[],
  onHandle?: (runtime: AgentRuntime, message: Memory) => Promise<void>,
): void {
  runtime.messageService = {
    async handleMessage(messageRuntime, message) {
      const prompt = String(message.content?.text ?? "");
      handledPrompts.push(prompt);
      await onHandle?.(messageRuntime, message);
      return {
        didRespond: true,
        responseContent: { text: `reply:${prompt}` },
        responseMessages: [],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "real-pglite-idempotency-proof",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  };
}

async function sendConversationMessage(
  state: ConversationRouteState,
  body: Record<string, unknown>,
  principalId: string,
): Promise<RouteResult> {
  const request = Object.assign(new http.IncomingMessage(null as never), {
    method: "POST",
    url: MESSAGE_PATH,
    headers: { host: "localhost" },
  });
  Object.defineProperty(request, "socket", {
    configurable: true,
    value: Object.assign(new EventEmitter(), {
      destroyed: false,
      remoteAddress: "127.0.0.1",
      writable: true,
    }),
  });
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
  }) as unknown as http.ServerResponse;
  let result: RouteResult | null = null;
  const context = {
    req: request,
    res: response,
    method: "POST",
    pathname: MESSAGE_PATH,
    state,
    callerAuthorization: {
      ok: true,
      role: "USER",
      identityId: principalId,
    },
    readJsonBody: vi.fn(async () => body),
    json: vi.fn(
      (
        _response: http.ServerResponse,
        payload: Record<string, unknown>,
        status = 200,
      ) => {
        result = { body: payload, status };
      },
    ),
    error: vi.fn(
      (_response: http.ServerResponse, message: string, status = 500) => {
        result = { body: { error: message }, status };
      },
    ),
  } as unknown as ConversationRouteContext;

  expect(await handleConversationRoutes(context)).toBe(true);
  if (!result) throw new Error("Conversation route completed without a result");
  return result;
}

async function readConversationMessages(
  runtime: AgentRuntime,
): Promise<Memory[]> {
  return runtime.getMemories({
    roomId: ROOM_ID,
    tableName: "messages",
    limit: 100,
    orderBy: "createdAt",
    orderDirection: "asc",
  });
}

describe("conversation idempotency across a real PGlite runtime restart", () => {
  let activeRuntime: RealTestRuntimeResult | null = null;
  let pgliteDir: string | null = null;

  afterEach(async () => {
    await activeRuntime?.cleanup();
    activeRuntime = null;
    __resetChatDedupeForTests();
    if (pgliteDir) {
      fs.rmSync(pgliteDir, { recursive: true, force: true });
      pgliteDir = null;
    }
  });

  it("replays exact outcomes without re-executing and scopes keys by principal", async () => {
    pgliteDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-idempotency-restart-pglite-"),
    );
    const handledPrompts: string[] = [];
    activeRuntime = await createRealTestRuntime({
      characterName: CHARACTER_NAME,
      pgliteDir,
      removePgliteDirOnCleanup: false,
    });
    installDeterministicMessageService(activeRuntime.runtime, handledPrompts);
    const firstState = createState(activeRuntime.runtime);
    const first = await sendConversationMessage(
      firstState,
      { text: "principal A command", clientMessageId: "shared-key" },
      "principal-a",
    );
    expect(first).toMatchObject({
      status: 200,
      body: { text: "reply:principal A command" },
    });
    expect(handledPrompts).toEqual(["principal A command"]);
    expect(await readConversationMessages(activeRuntime.runtime)).toHaveLength(
      2,
    );

    const originalAgentId = activeRuntime.runtime.agentId;
    await activeRuntime.cleanup();
    activeRuntime = null;
    __resetChatDedupeForTests();

    activeRuntime = await createRealTestRuntime({
      characterName: CHARACTER_NAME,
      pgliteDir,
      removePgliteDirOnCleanup: false,
    });
    expect(activeRuntime.runtime.agentId).toBe(originalAgentId);
    installDeterministicMessageService(activeRuntime.runtime, handledPrompts);
    const restartedState = createState(activeRuntime.runtime);

    const replay = await sendConversationMessage(
      restartedState,
      { text: "principal A command", clientMessageId: "shared-key" },
      "principal-a",
    );
    expect(replay).toEqual(first);
    expect(handledPrompts).toEqual(["principal A command"]);
    expect(await readConversationMessages(activeRuntime.runtime)).toHaveLength(
      2,
    );

    __resetChatDedupeForTests();
    const conflict = await sendConversationMessage(
      restartedState,
      { text: "changed command", clientMessageId: "shared-key" },
      "principal-a",
    );
    expect(conflict).toMatchObject({
      status: 409,
      body: {
        error: expect.stringContaining("different durable chat request"),
      },
    });
    expect(handledPrompts).toEqual(["principal A command"]);

    const otherPrincipal = await sendConversationMessage(
      restartedState,
      { text: "principal B command", clientMessageId: "shared-key" },
      "principal-b",
    );
    expect(otherPrincipal).toMatchObject({
      status: 200,
      body: { text: "reply:principal B command" },
    });
    expect(handledPrompts).toEqual([
      "principal A command",
      "principal B command",
    ]);

    __resetChatDedupeForTests();
    const otherReplay = await sendConversationMessage(
      restartedState,
      { text: "principal B command", clientMessageId: "shared-key" },
      "principal-b",
    );
    expect(otherReplay).toEqual(otherPrincipal);
    expect(handledPrompts).toEqual([
      "principal A command",
      "principal B command",
    ]);

    const malformed = await sendConversationMessage(
      restartedState,
      { text: "must not run", clientMessageId: "x".repeat(129) },
      "principal-a",
    );
    expect(malformed).toEqual({
      status: 400,
      body: {
        error:
          "clientMessageId must be a non-empty string of at most 128 characters",
      },
    });
    expect(handledPrompts).toEqual([
      "principal A command",
      "principal B command",
    ]);

    const durableMessages = await readConversationMessages(
      activeRuntime.runtime,
    );
    expect(durableMessages).toHaveLength(4);
    expect(
      durableMessages.filter(
        (memory) => memory.entityId === activeRuntime?.runtime.agentId,
      ),
    ).toHaveLength(2);
    expect(
      durableMessages.filter(
        (memory) => memory.entityId !== activeRuntime?.runtime.agentId,
      ),
    ).toHaveLength(2);
  }, 120_000);

  it("finalizes a crash-cut action once without re-running it", async () => {
    pgliteDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-idempotency-crash-cut-pglite-"),
    );
    const handledPrompts: string[] = [];
    const actionMemoryId = stringToUuid("crash-cut-action-effect") as UUID;
    activeRuntime = await createRealTestRuntime({
      characterName: CHARACTER_NAME,
      pgliteDir,
      removePgliteDirOnCleanup: false,
    });
    installDeterministicMessageService(
      activeRuntime.runtime,
      handledPrompts,
      async (runtime, message) => {
        await runtime.createMemory(
          {
            id: actionMemoryId,
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: message.roomId,
            content: { text: "durable action effect" },
          },
          "facts",
        );
      },
    );
    const originalCreateMemory = activeRuntime.runtime.createMemory.bind(
      activeRuntime.runtime,
    );
    const createMemorySpy = vi
      .spyOn(activeRuntime.runtime, "createMemory")
      .mockImplementation(async (...args) => {
        const [memory, tableName] = args;
        if (
          tableName === "messages" &&
          memory.entityId === activeRuntime?.runtime.agentId
        ) {
          throw new Error("crash cut before assistant terminal persistence");
        }
        return originalCreateMemory(...args);
      });
    const firstState = createState(activeRuntime.runtime);
    const body = {
      text: "commit one side effect",
      clientMessageId: "crash-cut-key",
    };

    const interrupted = await sendConversationMessage(
      firstState,
      body,
      "principal-a",
    );
    expect(interrupted.status).toBe(500);
    expect(handledPrompts).toEqual(["commit one side effect"]);
    expect(
      await activeRuntime.runtime.getMemories({
        roomId: ROOM_ID,
        tableName: "facts",
        limit: 10,
      }),
    ).toHaveLength(1);
    expect(await readConversationMessages(activeRuntime.runtime)).toHaveLength(
      1,
    );
    createMemorySpy.mockRestore();

    await activeRuntime.cleanup();
    activeRuntime = null;
    __resetChatDedupeForTests();
    activeRuntime = await createRealTestRuntime({
      characterName: CHARACTER_NAME,
      pgliteDir,
      removePgliteDirOnCleanup: false,
    });
    installDeterministicMessageService(activeRuntime.runtime, handledPrompts);
    const restartedState = createState(activeRuntime.runtime);

    const recovered = await sendConversationMessage(
      restartedState,
      body,
      "principal-a",
    );
    expect(recovered).toMatchObject({
      status: 200,
      body: { text: expect.stringContaining("was not run again") },
    });
    expect(handledPrompts).toEqual(["commit one side effect"]);
    expect(await readConversationMessages(activeRuntime.runtime)).toHaveLength(
      2,
    );
    expect(
      await activeRuntime.runtime.getMemories({
        roomId: ROOM_ID,
        tableName: "facts",
        limit: 10,
      }),
    ).toHaveLength(1);

    __resetChatDedupeForTests();
    const replay = await sendConversationMessage(
      restartedState,
      body,
      "principal-a",
    );
    expect(replay).toEqual(recovered);
    expect(handledPrompts).toEqual(["commit one side effect"]);
    expect(await readConversationMessages(activeRuntime.runtime)).toHaveLength(
      2,
    );
  }, 120_000);

  it("recovers a DMS-persisted equal-text assistant by its canonical user relation", async () => {
    pgliteDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-idempotency-dms-correlation-pglite-"),
    );
    const handledPrompts: string[] = [];
    const assistantId = stringToUuid("dms-equal-text-assistant") as UUID;
    const terminalText = "The persisted DMS reply.";
    activeRuntime = await createRealTestRuntime({
      characterName: CHARACTER_NAME,
      pgliteDir,
      removePgliteDirOnCleanup: false,
    });
    activeRuntime.runtime.messageService = {
      async handleMessage(runtime, message) {
        handledPrompts.push(String(message.content.text ?? ""));
        if (!message.id) throw new Error("user message id missing");
        const assistant: Memory = {
          id: assistantId,
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          roomId: message.roomId,
          content: {
            text: terminalText,
            inReplyTo: createUniqueUuid(runtime, message.id),
          },
        };
        await runtime.createMemory(assistant, "messages");
        return {
          didRespond: true,
          responseContent: assistant.content,
          responseMessages: [assistant],
          persistedResponseMessageIds: [assistantId],
          mode: "simple" as const,
        };
      },
      shouldRespond: () => ({
        shouldRespond: true,
        skipEvaluation: true,
        reason: "real-pglite-dms-correlation-proof",
      }),
      deleteMessage: async () => undefined,
      clearChannel: async () => undefined,
    };
    const originalUpdateMemory = activeRuntime.runtime.updateMemory.bind(
      activeRuntime.runtime,
    );
    let crashBeforeReconciliation = true;
    const updateMemorySpy = vi
      .spyOn(activeRuntime.runtime, "updateMemory")
      .mockImplementation(async (memory) => {
        if (crashBeforeReconciliation && memory.id === assistantId) {
          crashBeforeReconciliation = false;
          throw new Error(
            "crash cut after DMS assistant persistence before reconciliation",
          );
        }
        return originalUpdateMemory(memory);
      });
    const body = {
      text: "persist the DMS reply",
      clientMessageId: "dms-correlation-key",
    };
    const firstState = createState(activeRuntime.runtime);

    const interrupted = await sendConversationMessage(
      firstState,
      body,
      "principal-a",
    );
    expect(interrupted.status).toBe(500);
    expect(handledPrompts).toEqual(["persist the DMS reply"]);
    const beforeRestart = await readConversationMessages(activeRuntime.runtime);
    expect(beforeRestart).toHaveLength(2);
    const userMessage = beforeRestart.find(
      (memory) => memory.entityId !== activeRuntime?.runtime.agentId,
    );
    expect(userMessage?.id).toBeTruthy();
    expect(
      beforeRestart.find((memory) => memory.id === assistantId)?.content,
    ).toMatchObject({
      text: terminalText,
      inReplyTo: createUniqueUuid(
        activeRuntime.runtime,
        userMessage?.id as UUID,
      ),
    });
    updateMemorySpy.mockRestore();

    await activeRuntime.cleanup();
    activeRuntime = null;
    __resetChatDedupeForTests();
    activeRuntime = await createRealTestRuntime({
      characterName: CHARACTER_NAME,
      pgliteDir,
      removePgliteDirOnCleanup: false,
    });
    installDeterministicMessageService(activeRuntime.runtime, handledPrompts);
    const restartedState = createState(activeRuntime.runtime);

    const recovered = await sendConversationMessage(
      restartedState,
      body,
      "principal-a",
    );
    expect(recovered).toMatchObject({
      status: 200,
      body: { text: terminalText, messageId: assistantId },
    });
    expect(handledPrompts).toEqual(["persist the DMS reply"]);
    const recoveredRows = await readConversationMessages(activeRuntime.runtime);
    expect(recoveredRows).toHaveLength(2);
    expect(
      recoveredRows.find((memory) => memory.id === assistantId)?.content,
    ).toMatchObject({
      text: terminalText,
      inReplyTo: recoveredRows.find(
        (memory) => memory.entityId !== activeRuntime?.runtime.agentId,
      )?.id,
    });

    __resetChatDedupeForTests();
    const replay = await sendConversationMessage(
      restartedState,
      body,
      "principal-a",
    );
    expect(replay).toEqual(recovered);
    expect(handledPrompts).toEqual(["persist the DMS reply"]);
    expect(await readConversationMessages(activeRuntime.runtime)).toHaveLength(
      2,
    );
  }, 120_000);
});
