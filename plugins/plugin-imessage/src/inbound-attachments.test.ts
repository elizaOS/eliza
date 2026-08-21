/**
 * Inbound native Messages attachment integration test. The deterministic
 * harness drives the real chat.db polling and dispatch path with a downloaded
 * local file, while replacing only the runtime media-store service. It proves
 * attachment-only messages are ingested and raw Messages paths are rehosted as
 * canonical content-addressed handles before entering Memory state.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime, IFileStorageService, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ChatDbMessage, ChatDbReader } from "./chatdb-reader";
import { IMessageService } from "./service";
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
        }),
      ]);
      expect(JSON.stringify(memory)).not.toContain(attachmentPath);
      expect(createMemory).toHaveBeenCalledWith(memory, "messages");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
