/**
 * Exercises listInboxAction against a fake runtime and the in-process default
 * message-ref store: seeds cached refs of mixed sources, then asserts the
 * handler filters unread messages down to the requested sources. Deterministic
 * — no live model, no connector, no real DB.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { CONTEXT_ROUTING_STATE_KEY, validateToolArgs } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { messageAction } from "../../../advanced-capabilities/actions/message.ts";
import { listInboxAction } from "../actions/listInbox.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import {
  __resetDefaultMessageRefStoreForTests,
  getDefaultMessageRefStore,
} from "../message-ref-store.ts";
import { __resetDefaultTriageServiceForTests } from "../triage-service.ts";
import type { MessageRef } from "../types.ts";
import { createFakeRuntime, FAKE_AGENT_ID } from "./fake-runtime.ts";

function saveMessages(refs: readonly MessageRef[]): void {
  getDefaultMessageRefStore().saveMessages(refs, FAKE_AGENT_ID);
}

function messageRef(overrides: Partial<MessageRef>): MessageRef {
  return {
    id: "msg",
    source: "gmail",
    externalId: "external-msg",
    from: { identifier: "alice@example.com" },
    to: [{ identifier: "owner@example.com" }],
    snippet: "hello",
    receivedAtMs: 1_000,
    hasAttachments: false,
    isRead: false,
    ...overrides,
  };
}

class FixedListAdapter extends BaseMessageAdapter {
  readonly source = "gmail" as const;
  readonly seenOptions: Parameters<BaseMessageAdapter["listMessages"]>[1][] =
    [];

  constructor(
    private readonly refs: MessageRef[],
    private readonly failure?: unknown,
  ) {
    super();
  }

  isAvailable(): boolean {
    return true;
  }

  override capabilities() {
    return { ...super.capabilities(), list: true };
  }

  protected override async listMessagesImpl(
    _runtime: IAgentRuntime,
    opts: Parameters<BaseMessageAdapter["listMessages"]>[1],
  ): Promise<MessageRef[]> {
    this.seenOptions.push(opts);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return this.refs;
  }
}

async function registerAdapter(adapter: BaseMessageAdapter): Promise<void> {
  const { getDefaultTriageService } = await import("../triage-service.ts");
  getDefaultTriageService().register(adapter);
}

describe("listInboxAction", () => {
  beforeEach(() => {
    __resetDefaultMessageRefStoreForTests();
    __resetDefaultTriageServiceForTests();
  });

  it("filters cached unread messages to the requested sources", async () => {
    saveMessages([
      messageRef({
        id: "gmail-1",
        source: "gmail",
        externalId: "gmail-external-1",
        snippet: "gmail hit",
        receivedAtMs: 3_000,
      }),
      messageRef({
        id: "discord-1",
        source: "discord",
        externalId: "discord-external-1",
        snippet: "discord miss",
        receivedAtMs: 2_000,
      }),
    ]);
    await registerAdapter(new FixedListAdapter([]));

    const result = await listInboxAction.handler(
      createFakeRuntime(),
      messageRef({ id: "turn", source: "gmail" }) as never,
      undefined,
      { parameters: { sources: ["gmail"] } } as never,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ total: 1, returned: 1 });
    const messages = result.data?.messages;
    expect(messages).toBeDefined();
    if (!messages) {
      throw new Error("Expected aggregated inbox messages");
    }
    expect(
      (messages as Array<{ id: string }>).map((message) => message.id),
    ).toEqual(["gmail-1"]);
  });

  it("rejects a requested source that has no adapter able to list", async () => {
    // A cached ref must not stand in for a source that was never read.
    saveMessages([
      messageRef({ id: "gmail-1", externalId: "gmail-external-1" }),
    ]);
    const adapter = new FixedListAdapter([]);
    await registerAdapter(adapter);

    const result = await listInboxAction.handler(
      createFakeRuntime(),
      messageRef({ id: "turn" }) as never,
      undefined,
      { parameters: { sources: ["gmail", "whatsapp"] } } as never,
    );

    expect(result.success).toBe(false);
    expect(result.text).toBe(
      "Cannot read the inbox for: whatsapp (no inbox adapter is connected). Sources that can be read: gmail.",
    );
    expect(result.data?.messages).toBeUndefined();
    expect(adapter.seenOptions).toEqual([]);
  });

  it("asks the adapter for a channel scope instead of filtering cached refs", async () => {
    // A Gmail ref carries one channelId but the message is in every label in
    // its tags. Filtering the cache by channelId would drop "both-labels".
    const refs = [
      messageRef({
        id: "both-labels",
        externalId: "both-labels-external",
        worldId: "work@example.com",
        channelId: "INBOX",
        tags: ["INBOX", "Label_7"],
        receivedAtMs: 3_000,
      }),
      messageRef({
        id: "label-only",
        externalId: "label-only-external",
        worldId: "work@example.com",
        channelId: "Label_7",
        tags: ["Label_7"],
        receivedAtMs: 2_000,
      }),
    ];
    saveMessages(refs);
    const adapter = new FixedListAdapter(refs);
    await registerAdapter(adapter);

    const result = await listInboxAction.handler(
      createFakeRuntime(),
      messageRef({ id: "turn" }) as never,
      undefined,
      {
        parameters: {
          worldIds: ["work@example.com"],
          channelIds: ["Label_7"],
        },
      } as never,
    );

    expect(adapter.seenOptions).toHaveLength(1);
    expect(adapter.seenOptions[0]).toMatchObject({
      worldIds: ["work@example.com"],
      channelIds: ["Label_7"],
    });
    expect(
      (result.data as { messages: Array<{ id: string }> }).messages.map(
        (m) => m.id,
      ),
    ).toEqual(["both-labels", "label-only"]);
  });

  it("rejects an unsupported source instead of listing every source", async () => {
    saveMessages([
      messageRef({ id: "gmail-1", externalId: "gmail-external-1" }),
    ]);

    const result = await listInboxAction.handler(
      createFakeRuntime(),
      messageRef({ id: "turn" }) as never,
      undefined,
      { parameters: { sources: ["slack"] } } as never,
    );

    expect(result.success).toBe(false);
    expect(result.text).toBe(
      'source "slack" is not a supported message source; use one of: gmail, discord, telegram, twitter, imessage, whatsapp, calendly, browser_bridge',
    );
    expect(result.data?.messages).toBeUndefined();
  });

  it("validates messaging contexts and rejects unrelated contexts", async () => {
    const message = { content: { text: "show inbox" } } as never;
    const runtime = createFakeRuntime();

    expect(
      await listInboxAction.validate(runtime, message, {
        values: {
          [CONTEXT_ROUTING_STATE_KEY]: { primaryContext: "email" },
        },
      } as never),
    ).toBe(true);
    expect(
      await listInboxAction.validate(runtime, message, {
        values: {
          [CONTEXT_ROUTING_STATE_KEY]: { primaryContext: "wallet" },
        },
      } as never),
    ).toBe(false);
  });

  it("ranks cached messages, preserves equal-score ties, filters read mail, and applies the limit", async () => {
    saveMessages([
      messageRef({
        id: "read-newest",
        receivedAtMs: 9_000,
        isRead: true,
      }),
      messageRef({
        id: "equal-first",
        receivedAtMs: 5_000,
      }),
      messageRef({
        id: "tie-winner",
        receivedAtMs: 5_000,
        subject: "Important relationship",
        triageScore: {
          contactWeight: 0.9,
          userRepliedInThread: true,
          scoredAt: 5_001,
        },
      }),
      messageRef({
        id: "equal-second",
        receivedAtMs: 5_000,
      }),
      messageRef({
        id: "older",
        receivedAtMs: 4_000,
      }),
    ]);

    const result = await listInboxAction.handler(
      createFakeRuntime(),
      messageRef({ id: "turn" }) as never,
      undefined,
      { parameters: { limit: 3 } } as never,
    );

    expect(result.success).toBe(true);
    expect(result.text).toBe(
      "4 unread message(s) across 1 platform(s); details in data.messages.",
    );
    expect(result.data).toEqual({
      total: 4,
      returned: 3,
      messages: [
        {
          id: "tie-winner",
          source: "gmail",
          from: "alice@example.com",
          subject: "Important relationship",
          snippet: "hello",
          receivedAtMs: 5_000,
          contactWeight: 0.9,
          userRepliedInThread: true,
        },
        {
          id: "equal-first",
          source: "gmail",
          from: "alice@example.com",
          subject: null,
          snippet: "hello",
          receivedAtMs: 5_000,
          contactWeight: null,
          userRepliedInThread: null,
        },
        {
          id: "equal-second",
          source: "gmail",
          from: "alice@example.com",
          subject: null,
          snippet: "hello",
          receivedAtMs: 5_000,
          contactWeight: null,
          userRepliedInThread: null,
        },
      ],
    });
  });

  it("does not report an empty inbox when the limit trims every unread message", async () => {
    saveMessages([
      messageRef({ id: "unread-1", receivedAtMs: 2_000 }),
      messageRef({ id: "unread-2", receivedAtMs: 1_000 }),
    ]);

    const result = await listInboxAction.handler(
      createFakeRuntime(),
      messageRef({ id: "turn" }) as never,
      undefined,
      { parameters: { limit: 0 } } as never,
    );

    expect(result.text).toBe(
      "2 unread message(s) across 1 platform(s); details in data.messages.",
    );
    expect(result.data).toMatchObject({ total: 2, returned: 0 });
  });

  it("rejects a limit below 1 and the removed folder hint at the MESSAGE schema", () => {
    expect(
      validateToolArgs(messageAction, { action: "list_inbox", limit: 0 })
        .errors,
    ).toEqual(["Argument 'limit' value 0 is below minimum 1"]);
    expect(
      validateToolArgs(messageAction, { action: "list_inbox", limit: 5 }).valid,
    ).toBe(true);
    for (const action of ["triage", "list_inbox", "search_inbox"]) {
      expect(
        validateToolArgs(messageAction, { action, folder: "Promotions" }).valid,
      ).toBe(false);
      expect(
        validateToolArgs(messageAction, { action, channelIds: ["Promotions"] })
          .valid,
      ).toBe(true);
    }
  });

  it("pulls and scores live adapter messages when the cache is empty", async () => {
    const adapter = new FixedListAdapter([
      messageRef({
        id: "live-message",
        externalId: "live-external",
        receivedAtMs: 7_000,
      }),
    ]);
    await registerAdapter(adapter);

    const result = await listInboxAction.handler(
      createFakeRuntime(),
      messageRef({ id: "turn" }) as never,
      undefined,
      {
        parameters: {
          sources: ["gmail"],
          sinceMs: 6_000,
          limit: 10,
          worldIds: ["work@example.com"],
          channelIds: ["INBOX"],
        },
      } as never,
    );

    expect(adapter.seenOptions).toHaveLength(1);
    expect(adapter.seenOptions[0]).toMatchObject({
      sinceMs: 6_000,
      limit: 10,
      worldIds: ["work@example.com"],
      channelIds: ["INBOX"],
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      total: 1,
      returned: 1,
      messages: [
        {
          id: "live-message",
          contactWeight: 0.5,
          userRepliedInThread: false,
        },
      ],
    });
  });

  it("falls through to a live pull when the cache holds only read messages", async () => {
    // The store keeps every ref a sweep ever handed it and never prunes read
    // rows, so a warm all-read cache must not let the action claim an empty
    // inbox while the connector holds new unread mail.
    saveMessages([
      messageRef({
        id: "read-1",
        externalId: "read-external-1",
        isRead: true,
        receivedAtMs: 3_000,
      }),
    ]);
    const adapter = new FixedListAdapter([
      messageRef({
        id: "live-unread",
        externalId: "live-unread-external",
        receivedAtMs: 9_000,
      }),
    ]);
    await registerAdapter(adapter);

    const result = await listInboxAction.handler(
      createFakeRuntime(),
      messageRef({ id: "turn" }) as never,
      undefined,
      { parameters: { sources: ["gmail"] } } as never,
    );

    expect(adapter.seenOptions).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      total: 1,
      returned: 1,
      messages: [{ id: "live-unread" }],
    });
  });

  it("does not sweep again when a cold cache live pull is already all read", async () => {
    const adapter = new FixedListAdapter([
      messageRef({
        id: "live-read",
        externalId: "live-read-external",
        isRead: true,
      }),
    ]);
    await registerAdapter(adapter);

    const result = await listInboxAction.handler(
      createFakeRuntime(),
      messageRef({ id: "turn" }) as never,
    );

    expect(adapter.seenOptions).toHaveLength(1);
    expect(result).toMatchObject({
      success: true,
      text: "No unread messages across connected platforms.",
      data: { total: 0, returned: 0, messages: [] },
    });
  });

  it("claims no unread only after a live pull confirms it past an all-read cache", async () => {
    saveMessages([
      messageRef({
        id: "read-1",
        externalId: "read-external-1",
        isRead: true,
      }),
    ]);
    const adapter = new FixedListAdapter([
      messageRef({
        id: "also-read",
        externalId: "also-read-external",
        isRead: true,
      }),
    ]);
    await registerAdapter(adapter);

    const result = await listInboxAction.handler(
      createFakeRuntime(),
      messageRef({ id: "turn" }) as never,
    );

    // The empty answer is live-verified: the adapter pull must have run.
    expect(adapter.seenOptions).toHaveLength(1);
    expect(result).toMatchObject({
      success: true,
      text: "No unread messages across connected platforms.",
      data: { total: 0, returned: 0, messages: [] },
    });
  });

  it("pulls once when every cached row is older than the requested window", async () => {
    saveMessages([
      messageRef({ id: "old", externalId: "old", receivedAtMs: 1_000 }),
    ]);
    const adapter = new FixedListAdapter([
      messageRef({ id: "fresh", externalId: "fresh", receivedAtMs: 9_000 }),
    ]);
    await registerAdapter(adapter);
    const result = await listInboxAction.handler(
      createFakeRuntime(),
      messageRef({ id: "turn" }) as never,
      undefined,
      { parameters: { sinceMs: 5_000 } } as never,
    );
    expect(adapter.seenOptions).toHaveLength(1);
    expect(adapter.seenOptions[0]?.sinceMs).toBe(5_000);
    expect(result.data).toMatchObject({ messages: [{ id: "fresh" }] });
  });

  it("does not repeat a cold pull whose result contains only read messages", async () => {
    const adapter = new FixedListAdapter([
      messageRef({ id: "read", externalId: "read", isRead: true }),
    ]);
    await registerAdapter(adapter);
    const result = await listInboxAction.handler(
      createFakeRuntime(),
      messageRef({ id: "turn" }) as never,
    );
    expect(adapter.seenOptions).toHaveLength(1);
    expect(result.data).toMatchObject({ total: 0, returned: 0, messages: [] });
  });

  it("returns the explicit empty-inbox result when no source has messages", async () => {
    const result = await listInboxAction.handler(
      createFakeRuntime(),
      messageRef({ id: "turn" }) as never,
    );

    expect(result).toMatchObject({
      success: true,
      text: "No unread messages across connected platforms.",
      data: { total: 0, returned: 0, messages: [] },
    });
  });

  it("translates adapter errors into a failed action result", async () => {
    await registerAdapter(
      new FixedListAdapter([], new Error("gmail unavailable")),
    );

    const result = await listInboxAction.handler(
      createFakeRuntime(),
      messageRef({ id: "turn" }) as never,
    );

    expect(result).toEqual({
      success: false,
      text: "Failed to list inbox: gmail unavailable",
      error: "gmail unavailable",
      data: { actionName: "MESSAGE" },
    });
  });

  it("stringifies non-Error failures at the action boundary", async () => {
    await registerAdapter(new FixedListAdapter([], "connector refused"));

    const result = await listInboxAction.handler(
      createFakeRuntime(),
      messageRef({ id: "turn" }) as never,
    );

    expect(result).toEqual({
      success: false,
      text: "Failed to list inbox: connector refused",
      error: "connector refused",
      data: { actionName: "MESSAGE" },
    });
  });
});
