/**
 * Inbound native Messages attachment integration test. The deterministic
 * harness drives the real chat.db polling and dispatch path with a downloaded
 * local file, while replacing only the runtime media-store service. It proves
 * attachment-only messages are ingested and raw Messages paths are rehosted as
 * canonical content-addressed handles before entering Memory state.
 */
import crypto from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ElizaError,
  type IAgentRuntime,
  type IFileStorageService,
  type Memory,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ChatDbMessage, ChatDbReader } from "./chatdb-reader";
import {
  IMESSAGE_ATTACHMENT_READ_MAX_ATTEMPTS,
  IMESSAGE_INBOUND_PERSIST_MAX_ATTEMPTS,
  IMessageService,
} from "./service";
import type { IMessageSettings } from "./types";

describe("native Messages inbound attachments", () => {
  it("rehosts an attachment-only message before emitting and persisting it", async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "imessage-inbound-test-"));
    const attachmentPath = join(fixtureDir, "photo.png");
    const bytes = Buffer.from("downloaded Messages attachment");
    await writeFile(attachmentPath, bytes);

    try {
      const storedUrl = `/api/media/${"b".repeat(64)}.png`;
      const store = vi.fn(async (input: Buffer | Uint8Array, mimeType: string) => ({
        url: storedUrl,
        hash: "b".repeat(64),
        fileName: `${"b".repeat(64)}.png`,
        mimeType,
        size: input.byteLength,
      }));
      const storage = { store } as unknown as IFileStorageService;
      const emitted: Array<{ type: string; payload: unknown }> = [];
      const createMemory = vi.fn(async () => {});
      const runtime = {
        agentId: "00000000-0000-0000-0000-000000000001",
        getSetting: vi.fn(() => undefined),
        getService: vi.fn(() => storage),
        emitEvent: vi.fn((type: string, payload: unknown) => emitted.push({ type, payload })),
        ensureConnection: vi.fn(async () => {}),
        createMemory,
        reportError: vi.fn(() => {}),
      } as unknown as IAgentRuntime;
      const row: ChatDbMessage = {
        rowId: 44,
        guid: "message-guid-44",
        text: "",
        kind: "text",
        handle: "+15551234567",
        chatId: "iMessage;-;+15551234567",
        chatType: "direct",
        displayName: null,
        timestamp: 1_700_000_000_000,
        isFromMe: false,
        service: "iMessage",
        isSent: true,
        isDelivered: true,
        isRead: false,
        dateRead: 0,
        dateEdited: 0,
        dateRetracted: 0,
        replyToGuid: null,
        reaction: null,
        attachments: [
          {
            guid: "attachment-guid-1",
            filename: "photo.png",
            path: attachmentPath,
            uti: "public.png",
            mimeType: "image/png",
            totalBytes: bytes.byteLength,
            isSticker: false,
          },
        ],
      };
      const chatDb: Pick<ChatDbReader, "fetchNewMessages"> = {
        fetchNewMessages: vi.fn(() => [row]),
      };
      const service = new IMessageService(runtime);
      const internal = service as unknown as {
        chatDb: typeof chatDb;
        lastRowId: number;
        contactsLoadAttempted: boolean;
        settings: IMessageSettings;
        pollForNewMessagesInner(): Promise<void>;
      };
      internal.chatDb = chatDb;
      internal.lastRowId = 0;
      internal.contactsLoadAttempted = true;
      internal.settings = {
        pollIntervalMs: 0,
        heartbeatIntervalMs: 60_000,
        dmPolicy: "open",
        groupPolicy: "allowlist",
        allowFrom: [],
        enabled: true,
      };

      await internal.pollForNewMessagesInner();

      expect(store).toHaveBeenCalledWith(bytes, "image/png");
      const received = emitted.find(({ type }) => type === "MESSAGE_RECEIVED");
      const memory = (received?.payload as { message?: Memory } | undefined)?.message;
      expect(memory?.content.text).toBe("");
      expect(memory?.content.attachments).toEqual([
        expect.objectContaining({
          id: "attachment-guid-1",
          url: storedUrl,
          filename: "photo.png",
          mimeType: "image/png",
          size: bytes.byteLength,
          contentType: "image",
        }),
      ]);
      // A preset description makes the message pipeline skip image description.
      expect(memory?.content.attachments?.[0]).not.toHaveProperty("description");
      expect(JSON.stringify(memory)).not.toContain(attachmentPath);
      expect(createMemory).toHaveBeenCalledWith(memory, "messages");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  function textRow(rowId: number, text: string): ChatDbMessage {
    return {
      rowId,
      guid: `message-guid-retry-${rowId}`,
      text,
      kind: "text",
      handle: "+15551234567",
      chatId: "iMessage;-;+15551234567",
      chatType: "direct",
      displayName: null,
      timestamp: 1_700_000_000_000 + rowId,
      isFromMe: false,
      service: "iMessage",
      isSent: true,
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

  function pollHarness(
    rows: ChatDbMessage[],
    createMemory: ReturnType<typeof vi.fn>,
    fetchImpl?: ChatDbReader["fetchNewMessages"]
  ) {
    const fetchNewMessages = vi.fn(
      fetchImpl ??
        ((sinceRowId: number, limit: number) =>
          rows.filter((row) => row.rowId > sinceRowId).slice(0, limit))
    );
    const emitted: string[] = [];
    const reportError = vi.fn((_scope: string, _error: unknown, _context?: unknown) => {});
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      getSetting: vi.fn(() => undefined),
      getService: vi.fn(() => null),
      emitEvent: vi.fn(async (type: string) => {
        emitted.push(type);
      }),
      ensureConnection: vi.fn(async () => {}),
      createMemory,
      reportError,
    } as unknown as IAgentRuntime;
    const service = new IMessageService(runtime);
    const internal = service as unknown as {
      chatDb: Pick<ChatDbReader, "fetchNewMessages">;
      lastRowId: number;
      contactsLoadAttempted: boolean;
      settings: IMessageSettings;
      pollForNewMessagesInner(): Promise<void>;
    };
    internal.chatDb = { fetchNewMessages };
    internal.lastRowId = 0;
    internal.contactsLoadAttempted = true;
    internal.settings = {
      pollIntervalMs: 0,
      heartbeatIntervalMs: 60_000,
      dmPolicy: "open",
      groupPolicy: "allowlist",
      allowFrom: [],
      enabled: true,
    };
    return { internal, fetchNewMessages, emitted, reportError };
  }

  function reportedCodes(reportError: ReturnType<typeof vi.fn>): string[] {
    return reportError.mock.calls.map((call) => (call[1] as ElizaError).code);
  }

  it("retries a default-off inbound message after transient persistence failure", async () => {
    const row = textRow(44, "keep this message");
    const createMemory = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary database outage"))
      .mockResolvedValue(undefined);
    const { internal, fetchNewMessages, emitted } = pollHarness([row], createMemory);

    await internal.pollForNewMessagesInner();

    expect(internal.lastRowId).toBe(0);
    expect(emitted).not.toContain("MESSAGE_RECEIVED");

    await internal.pollForNewMessagesInner();

    expect(fetchNewMessages).toHaveBeenNthCalledWith(1, 0, 50);
    expect(fetchNewMessages).toHaveBeenNthCalledWith(2, 0, 50);
    expect(createMemory).toHaveBeenCalledTimes(2);
    expect(internal.lastRowId).toBe(44);
    expect(emitted.filter((type) => type === "MESSAGE_RECEIVED")).toHaveLength(1);
  });

  it("does not stall the cursor on a fatal persistence rejection", async () => {
    const poisoned = textRow(50, "contains an unsupported character");
    const later = textRow(51, "later message");
    const createMemory = vi.fn(async (memory: Memory) => {
      if (memory.content.text === poisoned.text) {
        throw new ElizaError("sql json text contains an unsupported NUL character", {
          code: "SQL_JSON_UNSUPPORTED_NUL",
          severity: "fatal",
        });
      }
    });
    const { internal, fetchNewMessages, emitted, reportError } = pollHarness(
      [poisoned, later],
      createMemory
    );

    await internal.pollForNewMessagesInner();

    expect(internal.lastRowId).toBe(51);
    expect(createMemory).toHaveBeenCalledTimes(2);
    expect(createMemory.mock.calls[1]?.[0].content.text).toBe(later.text);
    expect(emitted.filter((type) => type === "MESSAGE_RECEIVED")).toHaveLength(1);
    expect(reportedCodes(reportError)).toEqual(["IMESSAGE_INBOUND_PERSIST_REJECTED"]);

    await internal.pollForNewMessagesInner();

    expect(fetchNewMessages).toHaveBeenLastCalledWith(51, 50);
    expect(createMemory).toHaveBeenCalledTimes(2);
  });

  it("skips a row after bounded retries so later rows are not blocked", async () => {
    const stuck = textRow(60, "always fails");
    const later = textRow(61, "later message");
    const createMemory = vi.fn(async (memory: Memory) => {
      if (memory.content.text === stuck.text) {
        throw new Error("database keeps timing out");
      }
    });
    const { internal, emitted, reportError } = pollHarness([stuck, later], createMemory);

    for (let attempt = 1; attempt < IMESSAGE_INBOUND_PERSIST_MAX_ATTEMPTS; attempt++) {
      await internal.pollForNewMessagesInner();
      expect(internal.lastRowId).toBe(0);
    }
    expect(emitted).not.toContain("MESSAGE_RECEIVED");

    await internal.pollForNewMessagesInner();

    expect(internal.lastRowId).toBe(61);
    expect(createMemory).toHaveBeenCalledTimes(IMESSAGE_INBOUND_PERSIST_MAX_ATTEMPTS + 1);
    expect(createMemory.mock.calls.at(-1)?.[0].content.text).toBe(later.text);
    expect(emitted.filter((type) => type === "MESSAGE_RECEIVED")).toHaveLength(1);
    const codes = reportedCodes(reportError);
    expect(codes.at(-1)).toBe("IMESSAGE_INBOUND_PERSIST_REJECTED");
    expect(codes.filter((code) => code === "IMESSAGE_INBOUND_PERSIST_FAILED")).toHaveLength(
      IMESSAGE_INBOUND_PERSIST_MAX_ATTEMPTS
    );
  });
  function attachmentReadFailure(rowId: number): ElizaError {
    return new ElizaError("iMessage attachment metadata could not be read", {
      code: "IMESSAGE_ATTACHMENT_READ_FAILED",
      cause: new Error("database disk image is malformed"),
      context: { rowId },
      severity: "ephemeral",
    });
  }

  /** Mirrors the chat.db reader: a failing row throws unless the caller tolerates it. */
  function failingAttachmentFetch(
    rows: ChatDbMessage[],
    failingRowId: number,
    healAfter = Infinity
  ) {
    let failures = 0;
    return (
      sinceRowId: number,
      limit: number,
      options?: Parameters<ChatDbReader["fetchNewMessages"]>[2]
    ): ChatDbMessage[] => {
      const slice = rows.filter((row) => row.rowId > sinceRowId).slice(0, limit);
      return slice.map((row) => {
        if (row.rowId !== failingRowId || failures >= healAfter) return row;
        if (options?.tolerateAttachmentReadFailure?.has(row.rowId)) {
          return { ...row, attachments: [], attachmentReadFailed: true };
        }
        failures++;
        throw attachmentReadFailure(row.rowId);
      });
    };
  }

  it("keeps the cursor on a transient attachment metadata read failure", async () => {
    const earlier = textRow(70, "earlier message");
    const flaky = textRow(71, "message with a photo");
    const createMemory = vi.fn(async () => {});
    const { internal, emitted, reportError } = pollHarness(
      [earlier, flaky],
      createMemory,
      failingAttachmentFetch([earlier, flaky], 71, 1)
    );

    await internal.pollForNewMessagesInner();

    expect(internal.lastRowId).toBe(0);
    expect(createMemory).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();

    await internal.pollForNewMessagesInner();

    expect(internal.lastRowId).toBe(71);
    expect(createMemory.mock.calls.map((call) => call[0].content.text)).toEqual([
      earlier.text,
      flaky.text,
    ]);
    expect(emitted.filter((type) => type === "MESSAGE_RECEIVED")).toHaveLength(2);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports a persistent attachment metadata read failure and stops blocking later rows", async () => {
    const stuck = textRow(80, "message whose attachments never read");
    const later = textRow(81, "later message");
    const createMemory = vi.fn(async () => {});
    const { internal, fetchNewMessages, emitted, reportError } = pollHarness(
      [stuck, later],
      createMemory,
      failingAttachmentFetch([stuck, later], 80)
    );

    for (let attempt = 1; attempt < IMESSAGE_ATTACHMENT_READ_MAX_ATTEMPTS; attempt++) {
      await internal.pollForNewMessagesInner();
      expect(internal.lastRowId).toBe(0);
    }
    expect(createMemory).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();

    await internal.pollForNewMessagesInner();

    expect(reportedCodes(reportError)).toEqual(["IMESSAGE_ATTACHMENT_READ_FAILED"]);
    expect(reportError.mock.calls[0]?.[0]).toBe("IMessageService.inboundAttachmentRead");
    expect(reportError.mock.calls[0]?.[2]).toEqual({
      rowId: 80,
      attempts: IMESSAGE_ATTACHMENT_READ_MAX_ATTEMPTS,
    });
    expect(internal.lastRowId).toBe(81);
    expect(createMemory.mock.calls.map((call) => call[0].content.text)).toEqual([
      stuck.text,
      later.text,
    ]);
    expect(emitted.filter((type) => type === "MESSAGE_RECEIVED")).toHaveLength(2);

    await internal.pollForNewMessagesInner();

    expect(fetchNewMessages).toHaveBeenLastCalledWith(81, 50);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("does not swallow chat.db errors other than attachment read failures", async () => {
    const createMemory = vi.fn(async () => {});
    const { internal } = pollHarness([], createMemory, () => {
      throw new Error("unexpected reader failure");
    });

    await expect(internal.pollForNewMessagesInner()).rejects.toThrow("unexpected reader failure");
  });
});

describe("Blooio inbound attachments", () => {
  it("types each attachment from its file name so it can be described or transcribed", async () => {
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const cache = new Map<string, unknown>();
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      getSetting: vi.fn(() => undefined),
      getService: vi.fn(() => null),
      getCache: vi.fn(async (key: string) => cache.get(key)),
      setCache: vi.fn(async (key: string, value: unknown) => {
        cache.set(key, value);
        return true;
      }),
      deleteCache: vi.fn(async (key: string) => cache.delete(key)),
      emitEvent: vi.fn((type: string, payload: unknown) => emitted.push({ type, payload })),
      ensureConnection: vi.fn(async () => {}),
      createMemory: vi.fn(async () => {}),
      reportError: vi.fn(() => {}),
      registerTaskWorker: vi.fn(() => {}),
      createTask: vi.fn(async () => "00000000-0000-0000-0000-0000000000aa"),
      getTasks: vi.fn(async () => []),
      deleteTask: vi.fn(async () => {}),
    } as unknown as IAgentRuntime;
    const service = new IMessageService(runtime);
    (service as unknown as { settings: IMessageSettings }).settings = {
      transport: "blooio",
      pollIntervalMs: 0,
      heartbeatIntervalMs: 60_000,
      dmPolicy: "open",
      groupPolicy: "allowlist",
      allowFrom: [],
      enabled: true,
      blooioApiKey: "synthetic-api-key",
      blooioWebhookSecret: "synthetic-secret",
      blooioFromNumber: "+15551234567",
      blooioChannelId: "ch_synthetic",
    };
    const rawBody = JSON.stringify({
      id: "evt-blooio-1",
      type: "message.received",
      created_at: Math.floor(Date.now() / 1000),
      data: {
        message_id: "blooio-msg-1",
        channel_id: "ch_synthetic",
        sender: "+15557654321",
        text: "what is in this photo?",
        attachments: [
          { url: "https://media.blooio.com/a/IMG_0001.HEIC", name: "IMG_0001.HEIC" },
          { url: "https://media.blooio.com/a/voice.m4a", name: "Voice Memo.m4a" },
        ],
      },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHmac("sha256", "synthetic-secret")
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");

    expect(await service.handleBlooioWebhook(rawBody, `t=${timestamp},v1=${signature}`)).toBe(
      "accepted"
    );
    const received = emitted.find(({ type }) => type === "MESSAGE_RECEIVED");
    const attachments = (received?.payload as { message?: Memory } | undefined)?.message?.content
      .attachments;
    expect(attachments).toEqual([
      expect.objectContaining({
        filename: "IMG_0001.HEIC",
        mimeType: "image/heic",
        contentType: "image",
      }),
      expect.objectContaining({
        filename: "Voice Memo.m4a",
        mimeType: "audio/mp4",
        contentType: "audio",
      }),
    ]);
    for (const attachment of attachments ?? []) {
      expect(attachment).not.toHaveProperty("description");
    }
  });
});
