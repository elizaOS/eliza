/**
 * Outbound media coverage for the WhatsApp connector (#8876): agent attachments
 * ship as native WhatsApp media messages via sendMediaMessage, including turns
 * that carry attachments with empty text. Both transports (Cloud API + Baileys)
 * build their payload from the same WhatsAppMessage media type, so one path
 * covers both. Mocked runtime — runs offline.
 */
import crypto from "node:crypto";
import type { IAgentRuntime, Media, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BaileysClient } from "../src/clients/baileys-client";
import {
  toInboundWhatsAppMemoryId,
  WhatsAppConnectorService,
} from "../src/runtime-service";

type RuntimeSendHandler = Parameters<IAgentRuntime["registerSendHandler"]>[1];
type ConnectorTargetInfo = Parameters<RuntimeSendHandler>[1];
type ConnectorContent = Parameters<RuntimeSendHandler>[2];
type MessageConnectorRegistration = Parameters<
  IAgentRuntime["registerMessageConnector"]
>[0];

function makeRuntime(registrations: MessageConnectorRegistration[]): IAgentRuntime {
  return {
    agentId: "agent-1" as UUID,
    registerMessageConnector: vi.fn((registration: MessageConnectorRegistration) => {
      registrations.push(registration);
    }),
    registerSendHandler: vi.fn(),
    getRoom: vi.fn(async () => null),
    getMemoryById: vi.fn(async () => null),
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  } as never as IAgentRuntime;
}

const known = {
  chatId: "+14155552671",
  senderId: "+14155552671",
  label: "Alice",
  isGroup: false,
  lastMessageAt: 123,
};

function mockService() {
  return {
    connected: true,
    config: { transport: "cloudapi" },
    sendMessage: vi.fn(async () => ({ messages: [{ id: "wamid.1" }] })),
    sendMediaMessage: vi.fn(async () => undefined),
    listKnownTargets: vi.fn(() => [known]),
    getKnownTarget: vi.fn((chatId: string) =>
      chatId === known.chatId ? known : null,
    ),
    findKnownChatByParticipant: vi.fn((p: string) =>
      p === known.senderId ? known : null,
    ),
    fetchConnectorMessages: vi.fn(async () => []),
    searchConnectorMessages: vi.fn(async () => []),
    reactConnectorMessage: vi.fn(async () => undefined),
    getConnectorUser: vi.fn(async () => null),
  } as never as WhatsAppConnectorService;
}

const TARGET = {
  source: "whatsapp",
  entityId: "+1 (415) 555-2671" as UUID,
} as ConnectorTargetInfo;

describe("WhatsApp connector outbound media — send handler", () => {
  it("sends text then each attachment via sendMediaMessage", async () => {
    const registrations: MessageConnectorRegistration[] = [];
    const runtime = makeRuntime(registrations);
    const service = mockService();
    WhatsAppConnectorService.registerSendHandlers(runtime, service);

    await registrations[0].sendHandler?.(
      runtime,
      TARGET,
      {
        text: "here you go",
        attachments: [
          { id: "img", url: "https://cdn.example.com/cat.png", contentType: "image" },
          { id: "doc", url: "https://cdn.example.com/r.pdf", contentType: "document" },
        ],
      } as ConnectorContent,
    );

    expect(service.sendMessage).toHaveBeenCalledTimes(1);
    expect(service.sendMediaMessage).toHaveBeenCalledTimes(2);
    expect(service.sendMediaMessage).toHaveBeenCalledWith(
      "default",
      "+14155552671",
      expect.objectContaining({ url: "https://cdn.example.com/cat.png" }),
      undefined,
      undefined,
    );
  });

  it("sends an attachment-only message (no text) without a text send", async () => {
    const registrations: MessageConnectorRegistration[] = [];
    const runtime = makeRuntime(registrations);
    const service = mockService();
    WhatsAppConnectorService.registerSendHandlers(runtime, service);

    await registrations[0].sendHandler?.(
      runtime,
      TARGET,
      {
        text: "",
        attachments: [
          { id: "img", url: "https://cdn.example.com/cat.png", contentType: "image" },
        ],
      } as ConnectorContent,
    );

    expect(service.sendMessage).not.toHaveBeenCalled();
    expect(service.sendMediaMessage).toHaveBeenCalledTimes(1);
  });

  it("stops at the first failed attachment instead of fabricating partial success", async () => {
    const registrations: MessageConnectorRegistration[] = [];
    const runtime = makeRuntime(registrations);
    const service = mockService();
    vi.mocked(service.sendMediaMessage).mockRejectedValueOnce(new Error("provider rejected"));
    WhatsAppConnectorService.registerSendHandlers(runtime, service);

    await expect(
      registrations[0].sendHandler?.(
        runtime,
        TARGET,
        {
          text: "",
          attachments: [
            { id: "first", url: "https://cdn.example.com/first.png" },
            { id: "later", url: "https://cdn.example.com/later.png" },
          ],
        } as ConnectorContent,
      ),
    ).rejects.toThrow("provider rejected");

    expect(service.sendMediaMessage).toHaveBeenCalledTimes(1);
    expect(service.sendMediaMessage).toHaveBeenCalledWith(
      "default",
      "+14155552671",
      expect.objectContaining({ id: "first" }),
      undefined,
      undefined,
    );
  });
});

describe("WhatsApp sendMediaMessage — transport-agnostic media call", () => {
  function realServiceWithClient() {
    const clientSend = vi.fn(async () => ({ messages: [{ id: "x" }] }));
    const svc = Object.create(
      WhatsAppConnectorService.prototype,
    ) as WhatsAppConnectorService & {
      getClientForAccount: ReturnType<typeof vi.fn>;
      getConfigForAccount: ReturnType<typeof vi.fn>;
      sendMediaMessage: (
        accountId: string | null | undefined,
        to: string,
        media: Media,
        replyToMessageId?: string,
        quote?: {
          participant?: string;
          fromMe: boolean;
          type: "text" | "image" | "audio" | "video" | "document";
          text: string;
        },
      ) => Promise<void>;
    };
    (svc as { getClientForAccount: unknown }).getClientForAccount = vi.fn(() => ({
      sendMessage: clientSend,
    }));
    (svc as { getConfigForAccount: unknown }).getConfigForAccount = vi.fn(() => ({
      transport: "cloudapi",
    }));
    return { svc, clientSend };
  }

  it("maps coarse content type → WhatsApp media type and calls the client by link", async () => {
    const { svc, clientSend } = realServiceWithClient();
    await svc.sendMediaMessage("default", "+14155552671", {
      id: "img",
      url: "https://cdn.example.com/cat.png",
      contentType: "image",
      description: "a cat",
    } as Media);

    expect(clientSend).toHaveBeenCalledWith({
      type: "image",
      to: "+14155552671",
      content: { link: "https://cdn.example.com/cat.png", caption: "a cat" },
    });
  });

  it("derives type from mimeType and sets a document filename", async () => {
    const { svc, clientSend } = realServiceWithClient();
    await svc.sendMediaMessage("default", "+14155552671", {
      id: "doc",
      url: "https://cdn.example.com/report.pdf",
      mimeType: "application/pdf",
      filename: "report.pdf",
    } as Media);

    expect(clientSend).toHaveBeenCalledWith({
      type: "document",
      to: "+14155552671",
      content: {
        link: "https://cdn.example.com/report.pdf",
        filename: "report.pdf",
      },
    });
  });

  it("does not project personal quote reconstruction fields into Cloud media sends", async () => {
    const { svc, clientSend } = realServiceWithClient();
    await svc.sendMediaMessage(
      "default",
      "+14155552671",
      {
        id: "img",
        url: "https://cdn.example.com/cat.png",
        contentType: "image",
      } as Media,
      "wamid.parent",
      {
        participant: "14155552671@s.whatsapp.net",
        fromMe: false,
        type: "image",
        text: "caption",
      },
    );

    expect(clientSend).toHaveBeenCalledWith({
      type: "image",
      to: "+14155552671",
      content: { link: "https://cdn.example.com/cat.png" },
    });
  });
});

describe("WhatsApp sendMediaMessage — canonical personal bytes", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );

  function personalService(storedBytes: Buffer | null = png) {
    const clientSend = vi.fn(async () => ({ messages: [{ id: "x" }] }));
    const storage = { read: vi.fn(async () => storedBytes) };
    const svc = Object.create(
      WhatsAppConnectorService.prototype,
    ) as WhatsAppConnectorService;
    Object.assign(svc as object, {
      runtime: { getService: vi.fn(() => storage) },
      getClientForAccount: vi.fn(() => ({ sendMessage: clientSend })),
      getConfigForAccount: vi.fn(() => ({
        accountId: "default",
        transport: "baileys",
        authDir: "/tmp/auth",
        mediaMaxMb: 1,
      })),
    });
    return { svc, clientSend, storage };
  }

  function canonicalMedia(bytes = png): Media {
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    return {
      id: hash,
      checksum: hash,
      url: `/api/media/${hash}.png`,
      contentType: "image",
      mimeType: "image/png",
    } as Media;
  }

  it("reads and hash-verifies canonical bytes before the personal client call", async () => {
    const { svc, clientSend, storage } = personalService();
    const media = canonicalMedia();
    await svc.sendMediaMessage("default", "14155552671@s.whatsapp.net", media);

    expect(storage.read).toHaveBeenCalledWith(`${media.checksum}.png`);
    expect(clientSend).toHaveBeenCalledWith({
      type: "image",
      to: "14155552671@s.whatsapp.net",
      content: { link: media.url, bytes: png },
    });
  });

  it.each([
    ["external URL", { ...canonicalMedia(), url: "https://cdn.example.com/image.png" }, png],
    ["missing bytes", canonicalMedia(), null],
    ["corrupt store", canonicalMedia(), Buffer.from("wrong bytes")],
  ])("fails before personal client I/O for %s", async (_label, media, storedBytes) => {
    const { svc, clientSend } = personalService(storedBytes as Buffer | null);
    await expect(
      svc.sendMediaMessage("default", "14155552671@s.whatsapp.net", media as Media),
    ).rejects.toBeInstanceOf(Error);
    expect(clientSend).not.toHaveBeenCalled();
  });
});

describe("WhatsApp personal quoted delivery", () => {
  it("uses the same account-and-chat scope for default and named inbound reply identities", () => {
    const runtime = { agentId: "00000000-0000-0000-0000-000000000010" } as IAgentRuntime;

    const defaultParent = toInboundWhatsAppMemoryId(
      runtime,
      "default",
      "120363000000@g.us",
      "wamid.parent",
    );
    expect(
      toInboundWhatsAppMemoryId(
        runtime,
        "DEFAULT",
        "120363000000@g.us",
        "wamid.parent",
      ),
    ).toBe(defaultParent);
    expect(
      toInboundWhatsAppMemoryId(runtime, "work", "120363000000@g.us", "wamid.parent"),
    ).not.toBe(defaultParent);
  });

  it.each(["default", "work"])(
    "preserves %s-account group participant and image payload for text and media",
    async (accountId) => {
      const registrations: MessageConnectorRegistration[] = [];
      const socketSend = vi.fn(async () => ({ key: { id: "wamid.sent" } }));
      const client = new BaileysClient({ authDir: "/tmp/whatsapp-quote-test" });
      (
        client as unknown as { connection: { getSocket: () => unknown } }
      ).connection.getSocket = () => ({ sendMessage: socketSend });
      const runtime = makeRuntime(registrations);
      const replyBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      const replyHash = crypto.createHash("sha256").update(replyBytes).digest("hex");
      (runtime as unknown as { getService: ReturnType<typeof vi.fn> }).getService = vi.fn(() => ({
        read: vi.fn(async () => replyBytes),
      }));
      vi.mocked(runtime.getMemoryById).mockResolvedValueOnce({
        content: {
          text: "photo caption",
          attachments: [
            { id: "parent", contentType: "image", url: "/api/media/parent.png" },
          ],
        },
        metadata: {
          messageIdFull: "wamid.group-parent",
          rawSenderId: "14155552671@s.whatsapp.net",
          fromBot: false,
        },
      } as never);
      const service = Object.create(
        WhatsAppConnectorService.prototype,
      ) as WhatsAppConnectorService;
      Object.assign(service as object, {
        runtime,
        connected: true,
        defaultAccountId: accountId,
        configs: new Map([
          [accountId, { accountId, transport: "baileys", authDir: "/tmp/quote" }],
        ]),
        clients: new Map([[accountId, client]]),
        knownTargets: new Map(),
      });
      WhatsAppConnectorService.registerSendHandlers(runtime, service);

      await registrations[0].sendHandler?.(
        runtime,
        { source: "whatsapp", channelId: "120363000000@g.us" } as ConnectorTargetInfo,
        {
          text: "reply text",
          inReplyTo: "00000000-0000-0000-0000-000000000001" as UUID,
          attachments: [
            {
              id: replyHash,
              checksum: replyHash,
              url: `/api/media/${replyHash}.png`,
              contentType: "image",
              mimeType: "image/png",
            },
          ],
        } as ConnectorContent,
      );

      expect(socketSend).toHaveBeenCalledTimes(2);
      for (const call of socketSend.mock.calls) {
        expect(call[0]).toBe("120363000000@g.us");
        expect(call[2]).toEqual({
          quoted: {
            key: {
              remoteJid: "120363000000@g.us",
              id: "wamid.group-parent",
              fromMe: false,
              participant: "14155552671@s.whatsapp.net",
            },
            message: { imageMessage: { caption: "photo caption" } },
          },
        });
      }
    },
  );

  it.each([
    [null, "WHATSAPP_REPLY_PARENT_NOT_FOUND"],
    [{ content: { text: "parent" }, metadata: {} }, "WHATSAPP_REPLY_PROVIDER_ID_MISSING"],
  ])("fails closed before socket I/O for an invalid reply parent", async (parent, code) => {
    const registrations: MessageConnectorRegistration[] = [];
    const socketSend = vi.fn(async () => ({ key: { id: "must-not-send" } }));
    const client = new BaileysClient({ authDir: "/tmp/whatsapp-invalid-reply-test" });
    (client as unknown as { connection: { getSocket: () => unknown } }).connection.getSocket =
      () => ({ sendMessage: socketSend });
    const runtime = makeRuntime(registrations);
    vi.mocked(runtime.getMemoryById).mockResolvedValueOnce(parent as never);
    const service = Object.create(
      WhatsAppConnectorService.prototype,
    ) as WhatsAppConnectorService;
    Object.assign(service as object, {
      runtime,
      connected: true,
      defaultAccountId: "default",
      configs: new Map([
        ["default", { accountId: "default", transport: "baileys", authDir: "/tmp/quote" }],
      ]),
      clients: new Map([["default", client]]),
      knownTargets: new Map(),
    });
    WhatsAppConnectorService.registerSendHandlers(runtime, service);

    await expect(
      registrations[0].sendHandler?.(
        runtime,
        { source: "whatsapp", channelId: "120363000000@g.us" } as ConnectorTargetInfo,
        {
          text: "must not send",
          inReplyTo: "00000000-0000-0000-0000-000000000001" as UUID,
        } as ConnectorContent,
      ),
    ).rejects.toMatchObject({ code });
    expect(socketSend).not.toHaveBeenCalled();
  });
});
