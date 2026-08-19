/**
 * Regression coverage for the inbound poll access gate: verifies that
 * `IMessageService.pollForNewMessagesInner` enforces `IMESSAGE_GROUP_POLICY`
 * for group rows (open/allowlist/disabled) while leaving the DM policy path
 * unchanged. Drives the private poll method against a stub `chatDb` and a
 * recording runtime, asserting on the emitted `MESSAGE_RECEIVED` events — the
 * observable signal that a message was dispatched to the agent. The harness is
 * deterministic and offline; chat.db and Contacts are stubbed.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatDbMessage, ChatDbReader } from "./chatdb-reader";
import { IMessageService } from "./service";
import type { IMessageSettings } from "./types";

function makeRow(overrides: Partial<ChatDbMessage> = {}): ChatDbMessage {
  return {
    rowId: 1,
    guid: "guid-1",
    text: "hello there",
    kind: "text",
    handle: "+15551234567",
    chatId: "chat-abc",
    chatType: "direct",
    displayName: null,
    timestamp: 1_700_000_000_000,
    isFromMe: false,
    service: "iMessage",
    isSent: false,
    isDelivered: true,
    isRead: false,
    dateRead: 0,
    dateEdited: 0,
    dateRetracted: 0,
    replyToGuid: null,
    reaction: null,
    attachments: [],
    ...overrides,
  };
}

interface Harness {
  service: IMessageService;
  events: string[];
}

function makeHarness(row: ChatDbMessage, settings: Partial<IMessageSettings>): Harness {
  const events: string[] = [];
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    getSetting: vi.fn(() => undefined),
    getService: vi.fn(() => null),
    emitEvent: vi.fn((type: string) => {
      events.push(type);
    }),
    ensureConnection: vi.fn(async () => {}),
    createMemory: vi.fn(async () => {}),
    reportError: vi.fn(() => {}),
  } as unknown as IAgentRuntime;

  const service = new IMessageService(runtime);

  const chatDb: Pick<ChatDbReader, "fetchNewMessages"> = {
    fetchNewMessages: vi.fn((sinceRowId: number) => (row.rowId > sinceRowId ? [row] : [])),
  };

  const internal = service as unknown as {
    runtime: IAgentRuntime;
    chatDb: unknown;
    lastRowId: number;
    contactsLoadAttempted: boolean;
    settings: IMessageSettings;
  };
  internal.runtime = runtime;
  internal.chatDb = chatDb;
  internal.lastRowId = 0;
  // Skip the lazy Apple Contacts load so the harness stays offline.
  internal.contactsLoadAttempted = true;
  internal.settings = {
    cliPath: "imsg",
    pollIntervalMs: 5000,
    heartbeatIntervalMs: 60_000,
    dmPolicy: "pairing",
    groupPolicy: "allowlist",
    allowFrom: [],
    enabled: true,
    ...settings,
  };

  return { service, events };
}

async function poll(service: IMessageService): Promise<void> {
  await (
    service as unknown as { pollForNewMessagesInner(): Promise<void> }
  ).pollForNewMessagesInner();
}

describe("inbound poll gate — group policy enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not dispatch a group message when groupPolicy=disabled", async () => {
    const { service, events } = makeHarness(
      makeRow({ chatType: "group", handle: "+15550000001" }),
      { groupPolicy: "disabled", allowFrom: [] }
    );
    await poll(service);
    expect(events).not.toContain("MESSAGE_RECEIVED");
  });

  it("dispatches a group message when groupPolicy=open even with an empty allowlist", async () => {
    const { service, events } = makeHarness(
      makeRow({ chatType: "group", handle: "+15550000002" }),
      { groupPolicy: "open", allowFrom: [] }
    );
    await poll(service);
    expect(events).toContain("MESSAGE_RECEIVED");
  });

  it("does not dispatch a group message under allowlist when the sender is not listed", async () => {
    const { service, events } = makeHarness(
      makeRow({ chatType: "group", handle: "+15550000003" }),
      { groupPolicy: "allowlist", allowFrom: ["+15559999999"] }
    );
    await poll(service);
    expect(events).not.toContain("MESSAGE_RECEIVED");
  });

  it("dispatches a group message under allowlist when the sender is listed", async () => {
    const { service, events } = makeHarness(
      makeRow({ chatType: "group", handle: "+15550000004" }),
      { groupPolicy: "allowlist", allowFrom: ["+15550000004"] }
    );
    await poll(service);
    expect(events).toContain("MESSAGE_RECEIVED");
  });

  it("does not let a permissive dmPolicy admit a group message that groupPolicy forbids", async () => {
    // The original defect: dmPolicy=open (allow) leaked group rows through
    // regardless of groupPolicy=disabled.
    const { service, events } = makeHarness(
      makeRow({ chatType: "group", handle: "+15550000005" }),
      { dmPolicy: "open", groupPolicy: "disabled", allowFrom: [] }
    );
    await poll(service);
    expect(events).not.toContain("MESSAGE_RECEIVED");
  });
});

describe("inbound poll gate — DM policy regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches a DM when dmPolicy=open", async () => {
    const { service, events } = makeHarness(
      makeRow({ chatType: "direct", handle: "+15551110001" }),
      { dmPolicy: "open", allowFrom: [] }
    );
    await poll(service);
    expect(events).toContain("MESSAGE_RECEIVED");
  });

  it("does not dispatch a DM when dmPolicy=disabled", async () => {
    const { service, events } = makeHarness(
      makeRow({ chatType: "direct", handle: "+15551110002" }),
      { dmPolicy: "disabled", allowFrom: [] }
    );
    await poll(service);
    expect(events).not.toContain("MESSAGE_RECEIVED");
  });

  it("honors dmPolicy=allowlist for DM senders", async () => {
    const listed = makeHarness(makeRow({ chatType: "direct", handle: "+15551110003" }), {
      dmPolicy: "allowlist",
      allowFrom: ["+15551110003"],
    });
    await poll(listed.service);
    expect(listed.events).toContain("MESSAGE_RECEIVED");

    const unlisted = makeHarness(makeRow({ chatType: "direct", handle: "+15551110004" }), {
      dmPolicy: "allowlist",
      allowFrom: ["+15559999999"],
    });
    await poll(unlisted.service);
    expect(unlisted.events).not.toContain("MESSAGE_RECEIVED");
  });

  it("admits a group message under groupPolicy=allowlist while denying the same handle in a disabled group", async () => {
    // Confirms the group branch reads groupPolicy, not dmPolicy: same handle,
    // same allowlist, different group policy => different outcome.
    const admitted = makeHarness(makeRow({ chatType: "group", handle: "+15551110005" }), {
      dmPolicy: "disabled",
      groupPolicy: "allowlist",
      allowFrom: ["+15551110005"],
    });
    await poll(admitted.service);
    expect(admitted.events).toContain("MESSAGE_RECEIVED");

    const denied = makeHarness(makeRow({ chatType: "group", handle: "+15551110005" }), {
      dmPolicy: "open",
      groupPolicy: "disabled",
      allowFrom: ["+15551110005"],
    });
    await poll(denied.service);
    expect(denied.events).not.toContain("MESSAGE_RECEIVED");
  });
});
