/**
 * Regression coverage for the inbound dispatch log preview emitted by
 * `IMessageService.pollForNewMessagesInner`. Drives the real private poll
 * method against a stub `chatDb` and a recording runtime, capturing the actual
 * `logger.debug` line so the preview is asserted as the shipped code produces
 * it. The harness is deterministic and offline; chat.db and Contacts are
 * stubbed and no AppleScript runs.
 */
import { type IAgentRuntime, logger } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatDbMessage, ChatDbReader } from "./chatdb-reader";
import { IMessageService } from "./service";
import type { IMessageSettings } from "./types";

/** Code-unit budget the dispatch preview truncates to in service.ts. */
const PREVIEW_MAX_CODE_UNITS = 40;

function makeRow(text: string): ChatDbMessage {
  return {
    rowId: 1,
    guid: "guid-1",
    text,
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
  };
}

function makeService(row: ChatDbMessage): IMessageService {
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    getSetting: vi.fn(() => undefined),
    getService: vi.fn(() => null),
    emitEvent: vi.fn(() => {}),
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
  internal.contactsLoadAttempted = true;
  internal.settings = {
    pollIntervalMs: 5000,
    heartbeatIntervalMs: 60_000,
    dmPolicy: "open",
    groupPolicy: "open",
    allowFrom: [],
    enabled: true,
  };
  return service;
}

/**
 * Runs one real poll tick and returns the `text="..."` payload of the
 * `[imessage][dispatch]` debug line the shipped code emitted.
 */
async function capturePreview(text: string): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(logger, "debug").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string") {
      lines.push(args[0]);
    }
  });
  try {
    const service = makeService(makeRow(text));
    await (
      service as unknown as { pollForNewMessagesInner(): Promise<void> }
    ).pollForNewMessagesInner();
  } finally {
    spy.mockRestore();
  }
  const line = lines.find((entry) => entry.startsWith("[imessage][dispatch] "));
  expect(line, "the dispatch preview line was never logged").toBeDefined();
  const match = /text="([\s\S]*)"$/.exec(line as string);
  expect(match, `dispatch line had no text preview: ${line}`).not.toBeNull();
  return (match as RegExpExecArray)[1];
}

describe("iMessage dispatch log preview", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never emits a lone surrogate when the cut lands inside an emoji pair", async () => {
    // The grinning face occupies code units 39 and 40, so a plain
    // slice(0, 40) keeps only its lead half and yields malformed UTF-16.
    const text = `${"a".repeat(PREVIEW_MAX_CODE_UNITS - 1)}\u{1F600} trailing text`;
    expect(text.charCodeAt(PREVIEW_MAX_CODE_UNITS - 1)).toBe(0xd83d);

    const preview = await capturePreview(text);

    expect(preview.isWellFormed()).toBe(true);
    expect(preview).toBe("a".repeat(PREVIEW_MAX_CODE_UNITS - 1));
    expect(preview.length).toBeLessThan(PREVIEW_MAX_CODE_UNITS);
  });

  it("keeps a whole emoji when the pair ends exactly on the boundary", async () => {
    const text = `${"b".repeat(PREVIEW_MAX_CODE_UNITS - 2)}\u{1F600}cdef`;
    const preview = await capturePreview(text);

    expect(preview.isWellFormed()).toBe(true);
    expect(preview).toBe(`${"b".repeat(PREVIEW_MAX_CODE_UNITS - 2)}\u{1F600}`);
  });

  it("passes short text through unchanged", async () => {
    const preview = await capturePreview("hello there");
    expect(preview).toBe("hello there");
  });
});
