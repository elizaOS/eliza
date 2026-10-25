/**
 * Exercises manageMessageAction through the real default TriageService and an
 * in-process recording adapter. The suite covers validation, target lookup,
 * operation mapping, service failures, callbacks, and unsubscribe confirmation
 * without a live connector, model, or database.
 */

import type {
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

import { logger, validateToolArgs } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messageAction } from "../../../advanced-capabilities/actions/message.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import { __resetDefaultMessageRefStoreForTests } from "../message-ref-store.ts";
import {
  __resetDefaultTriageServiceForTests,
  getDefaultTriageService,
} from "../triage-service.ts";
import type {
  ListOptions,
  ManageOperation,
  ManageResult,
  MessageAdapterCapabilities,
  MessageRef,
  MessageSource,
} from "../types.ts";
import { manageMessageAction } from "./manageMessage.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as const;

class RecordingManageAdapter extends BaseMessageAdapter {
  readonly source: MessageSource = "gmail";
  messages: MessageRef[] = [];
  manageResult: ManageResult = { ok: true };
  requesters: Array<Memory | undefined> = [];
  managed: Array<{ messageId: string; operation: ManageOperation }> = [];

  unsubscribe = true;

  isAvailable(): boolean {
    return true;
  }

  capabilities(): MessageAdapterCapabilities {
    return {
      ...super.capabilities(),
      manage: { unsubscribe: this.unsubscribe },
    };
  }

  protected listMessagesImpl(
    _runtime: IAgentRuntime,
    _opts: ListOptions,
  ): Promise<MessageRef[]> {
    return Promise.resolve(this.messages);
  }

  protected manageMessageImpl(
    _runtime: IAgentRuntime,
    messageId: string,
    operation: ManageOperation,
    context?: { requester?: Memory },
  ): Promise<ManageResult> {
    expect(context?.requester).toBeDefined();
    this.requesters.push(context?.requester);
    this.managed.push({ messageId, operation });
    return Promise.resolve(this.manageResult);
  }
}

const turn = {
  entityId: "00000000-0000-0000-0000-000000000001",
  content: { text: "Manage that message", source: "gmail" },
} as Memory;

function options(parameters: Record<string, unknown>): HandlerOptions {
  return { parameters } as HandlerOptions;
}

function stateFor(primaryContext: string): State {
  return {
    values: { __contextRouting: { primaryContext } },
    data: {},
    text: "",
  };
}

function messageRef(
  id: string,
  receivedAtMs: number,
  overrides: Partial<MessageRef> = {},
): MessageRef {
  return {
    id,
    source: "gmail",
    externalId: `external-${id}`,
    from: { identifier: "newsletter@example.com" },
    to: [{ identifier: "owner@example.com" }],
    subject: "Weekly update",
    snippet: "Project news",
    receivedAtMs,
    hasAttachments: false,
    isRead: false,
    ...overrides,
  };
}

function createRuntime(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: AGENT_ID,
    getCache: <T>(key: string) =>
      Promise.resolve(cache.get(key) as T | undefined),
    setCache: (key: string, value: unknown) => {
      cache.set(key, value);
      return Promise.resolve(true);
    },
    deleteCache: (key: string) => {
      cache.delete(key);
      return Promise.resolve(true);
    },
  } as unknown as IAgentRuntime;
}

describe("manageMessageAction", () => {
  let adapter: RecordingManageAdapter;

  beforeEach(() => {
    __resetDefaultMessageRefStoreForTests();
    __resetDefaultTriageServiceForTests();
    adapter = new RecordingManageAdapter();
    const service = getDefaultTriageService();
    service.register(adapter);
    service.getStore().saveMessages([messageRef("direct-1", 2_000)], AGENT_ID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetDefaultTriageServiceForTests();
    __resetDefaultMessageRefStoreForTests();
  });

  it("is eligible only in a supported messaging context", async () => {
    await expect(
      manageMessageAction.validate?.(
        createRuntime(),
        turn,
        stateFor("messaging"),
      ),
    ).resolves.toBe(true);
    await expect(
      manageMessageAction.validate?.(
        createRuntime(),
        turn,
        stateFor("payments"),
      ),
    ).resolves.toBe(false);
  });

  it.each([
    [{}, "manageOperation is required (archive|trash|spam|mark_read|"],
    [
      { source: "slack", manageOperation: "archive" },
      'source "slack" is not a supported message source; use one of: gmail, discord,',
    ],
    [
      { messageId: "direct-1", manageOperation: "label_add" },
      "label is required for manageOperation=label_add",
    ],
    [
      { messageId: "direct-1", manageOperation: "tag_remove" },
      "tag is required for manageOperation=tag_remove",
    ],
    [
      { sources: ["slack"], sender: "a@example.com", manageOperation: "trash" },
      'source "slack" is not a supported message source',
    ],
  ])(
    "rejects invalid parameters before managing a message",
    async (params, error) => {
      const result = await manageMessageAction.handler(
        createRuntime(),
        turn,
        undefined,
        options(params),
      );

      expect(result.success).toBe(false);
      expect(result.text).toContain(error);
      expect(adapter.managed).toEqual([]);
    },
  );

  it("uses an explicit message id without searching and delivers success", async () => {
    const delivered: Content[] = [];
    const callback: HandlerCallback = async (content) => {
      delivered.push(content);
      return [];
    };

    const result = await manageMessageAction.handler(
      createRuntime(),
      turn,
      undefined,
      options({ messageId: "direct-1", operation: "archive" }),
      callback,
    );

    expect(adapter.managed).toEqual([
      { messageId: "direct-1", operation: { kind: "archive" } },
    ]);
    expect(result).toMatchObject({
      success: true,
      text: "Archived that message.",
      userFacingText: "Archived that message.",
      verifiedUserFacing: true,
      turnComplete: true,
      data: { ok: true, messageId: "direct-1", operation: "archive" },
    });
    expect(delivered).toEqual([
      { text: "Archived that message.", action: "MESSAGE" },
    ]);
  });

  it("selects the newest matching lookup result and forwards the source hint", async () => {
    adapter.messages = [
      messageRef("older", 1_000),
      messageRef("newest", 3_000),
      messageRef("other-sender", 4_000, {
        from: { identifier: "other@example.com" },
      }),
    ];

    const result = await manageMessageAction.handler(
      createRuntime(),
      turn,
      undefined,
      options({
        source: "gmail",
        sender: "newsletter@example.com",
        content: "project",
        operation: "trash",
      }),
    );

    expect(result.data).toMatchObject({
      messageId: "newest",
      operation: "trash",
    });
    expect(adapter.managed).toEqual([
      { messageId: "newest", operation: { kind: "trash" } },
    ]);
  });

  it("reports an empty lookup without attempting a mutation", async () => {
    const result = await manageMessageAction.handler(
      createRuntime(),
      turn,
      undefined,
      options({ sender: "missing@example.com", operation: "spam" }),
    );

    expect(result).toEqual({
      success: false,
      text: "No matching message found to manage.",
      error: "No matching message found to manage.",
    });
    expect(adapter.managed).toEqual([]);
  });

  it.each([
    ["archive", {}],
    ["trash", {}],
    ["trash", { source: "gmail" }],
    ["unsubscribe", {}],
  ])(
    "rejects %s with no message id and no sender or content hint",
    async (operation, extras) => {
      adapter.messages = [messageRef("newest", 3_000)];

      const result = await manageMessageAction.handler(
        createRuntime(),
        turn,
        undefined,
        options({ operation, ...extras }),
      );

      expect(result).toEqual({
        success: false,
        text: "messageId or a sender/content hint is required",
        error: "messageId or a sender/content hint is required",
      });
      expect(adapter.managed).toEqual([]);
    },
  );

  it("applies tags to the local store without calling the adapter", async () => {
    adapter.manageResult = { ok: false, reason: "adapter has no tags" };
    const store = getDefaultTriageService().getStore();

    const added = await manageMessageAction.handler(
      createRuntime(),
      turn,
      undefined,
      options({ messageId: "direct-1", operation: "tag_add", tag: "urgent" }),
    );

    expect(added).toMatchObject({
      success: true,
      text: "Tagged that message.",
    });
    expect(store.getMessage("direct-1", AGENT_ID)?.tags).toEqual(["urgent"]);

    const removed = await manageMessageAction.handler(
      createRuntime(),
      turn,
      undefined,
      options({
        messageId: "direct-1",
        operation: "tag_remove",
        tag: "urgent",
      }),
    );

    expect(removed).toMatchObject({
      success: true,
      text: "Removed the tag.",
    });
    expect(store.getMessage("direct-1", AGENT_ID)?.tags).toEqual([]);
    expect(adapter.managed).toEqual([]);
  });

  it("no longer accepts mute_thread, which no adapter implements", async () => {
    const result = await manageMessageAction.handler(
      createRuntime(),
      turn,
      undefined,
      options({ messageId: "direct-1", operation: "mute_thread" }),
    );

    expect(
      validateToolArgs(messageAction, {
        action: "manage",
        manageOperation: "mute_thread",
        messageId: "direct-1",
      }).valid,
    ).toBe(false);
    expect(result.success).toBe(false);
    expect(result.text).toBe(
      "manageOperation is required (archive|trash|spam|mark_read|label_add|label_remove|tag_add|tag_remove|unsubscribe)",
    );
    expect(adapter.managed).toEqual([]);
  });

  it("fails tag addition and tag removal for a missing stored message", async () => {
    const addResult = await manageMessageAction.handler(
      createRuntime(),
      turn,
      undefined,
      options({
        messageId: "missing",
        source: "gmail",
        operation: "tag_add",
        tag: "follow-up",
      }),
    );

    expect(addResult).toMatchObject({
      success: false,
      text: "message missing not in store",
      data: { messageId: "missing", operation: "tag_add" },
    });
    expect(adapter.managed).toEqual([]);

    const removeResult = await manageMessageAction.handler(
      createRuntime(),
      turn,
      undefined,
      options({
        messageId: "missing",
        source: "gmail",
        operation: "tag_remove",
        tag: "follow-up",
      }),
    );

    expect(removeResult).toMatchObject({
      success: false,
      text: "message missing not in store",
      data: { messageId: "missing", operation: "tag_remove" },
    });
    expect(adapter.managed).toEqual([]);
  });

  it.each([
    [
      { ok: false, reason: "provider rejected the request" },
      "provider rejected the request",
      "provider rejected the request",
    ],
    [
      { ok: false },
      "Operation archive on message direct-1 did not complete.",
      null,
    ],
  ])(
    "keeps service failures planner-facing",
    async (manageResult, text, reason) => {
      adapter.manageResult = manageResult;

      const result = await manageMessageAction.handler(
        createRuntime(),
        turn,
        undefined,
        options({ messageId: "direct-1", operation: "archive" }),
      );

      expect(result).toEqual({
        success: false,
        text,
        data: {
          ok: false,
          reason,
          messageId: "direct-1",
          operation: "archive",
        },
      });
    },
  );

  it("reports the resolved lookup target on a reasonless failure", async () => {
    adapter.messages = [messageRef("resolved-target", 3_000)];
    adapter.manageResult = { ok: false };
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    const result = await manageMessageAction.handler(
      createRuntime(),
      turn,
      undefined,
      options({
        sender: "newsletter@example.com",
        content: "project",
        operation: "archive",
      }),
    );

    expect(result).toEqual({
      success: false,
      text: "Operation archive on message resolved-target did not complete.",
      data: {
        ok: false,
        reason: null,
        messageId: "resolved-target",
        operation: "archive",
      },
    });
    expect(adapter.managed).toEqual([
      { messageId: "resolved-target", operation: { kind: "archive" } },
    ]);
    expect(info).toHaveBeenCalledWith(
      "[ManageMessage] op=archive messageId=resolved-target not ok: Operation archive on message resolved-target did not complete.",
    );
  });

  it.each([
    ["trash", {}, "Moved that message to trash.", { kind: "trash" }],
    ["spam", {}, "Marked that message as spam.", { kind: "spam" }],
    ["mark_read", {}, "Marked it read.", { kind: "mark_read", read: true }],
    [
      "mark_read",
      { read: false },
      "Marked it unread.",
      { kind: "mark_read", read: false },
    ],
    [
      "label_add",
      { label: "Receipts" },
      "Added the label.",
      { kind: "label_add", label: "Receipts" },
    ],
    [
      "label_remove",
      { label: "Receipts" },
      "Removed the label.",
      { kind: "label_remove", label: "Receipts" },
    ],
    ["block_sender", {}, "Marked that message as spam.", { kind: "spam" }],
  ])(
    "maps %s to the real operation and success text",
    async (operation, extras, text, expectedOperation) => {
      const result = await manageMessageAction.handler(
        createRuntime(),
        turn,
        undefined,
        options({ messageId: "direct-1", operation, ...extras }),
      );

      expect(result.text).toBe(text);
      expect(adapter.managed).toEqual([
        { messageId: "direct-1", operation: expectedOperation },
      ]);
    },
  );

  it("refuses unsubscribe before asking when the adapter cannot unsubscribe", async () => {
    adapter.unsubscribe = false;
    const delivered: Content[] = [];

    const result = await manageMessageAction.handler(
      createRuntime(),
      turn,
      undefined,
      options({ messageId: "direct-1", operation: "unsubscribe" }),
      async (content) => {
        delivered.push(content);
        return [];
      },
    );

    expect(result).toEqual({
      success: false,
      text: "gmail adapter does not support unsubscribe",
      data: {
        ok: false,
        reason: "gmail adapter does not support unsubscribe",
        messageId: "direct-1",
        operation: "unsubscribe",
      },
    });
    expect(delivered).toEqual([]);
    expect(adapter.managed).toEqual([]);
  });

  it("requires a second turn before unsubscribe and cancels a non-confirmation", async () => {
    const runtime = createRuntime();
    const delivered: Content[] = [];
    const callback: HandlerCallback = async (content) => {
      delivered.push(content);
      return [];
    };
    const pending = await manageMessageAction.handler(
      runtime,
      turn,
      undefined,
      options({ messageId: "direct-1", operation: "unsubscribe" }),
      callback,
    );

    expect(pending).toMatchObject({
      success: true,
      data: {
        requiresConfirmation: true,
        awaitingUserInput: true,
        cancelled: false,
        messageId: "direct-1",
        operation: "unsubscribe",
      },
    });
    expect(adapter.managed).toEqual([]);
    expect(delivered).toEqual([
      {
        text: "Unsubscribe from the sender of message direct-1?",
        source: "gmail",
      },
    ]);
    delivered.length = 0;

    const cancelled = await manageMessageAction.handler(
      runtime,
      { ...turn, content: { ...turn.content, text: "no" } } as Memory,
      undefined,
      options({ messageId: "direct-1", operation: "unsubscribe" }),
      callback,
    );

    expect(cancelled).toMatchObject({
      success: false,
      text: "Unsubscribe cancelled.",
      data: { requiresConfirmation: false, cancelled: true },
    });
    expect(adapter.managed).toEqual([]);
    expect(delivered).toEqual([
      { text: "Unsubscribe cancelled.", action: "MESSAGE" },
    ]);
  });

  it("executes unsubscribe after a matching confirmation", async () => {
    const runtime = createRuntime();
    await manageMessageAction.handler(
      runtime,
      turn,
      undefined,
      options({ messageId: "direct-1", operation: "unsubscribe" }),
    );

    const confirmed = await manageMessageAction.handler(
      runtime,
      { ...turn, content: { ...turn.content, text: "yes" } } as Memory,
      undefined,
      options({ messageId: "direct-1", operation: "unsubscribe" }),
    );

    expect(confirmed).toMatchObject({
      success: true,
      text: "Unsubscribed from that sender.",
      data: { messageId: "direct-1", operation: "unsubscribe" },
    });
    expect(adapter.managed).toEqual([
      { messageId: "direct-1", operation: { kind: "unsubscribe" } },
    ]);
  });
});
