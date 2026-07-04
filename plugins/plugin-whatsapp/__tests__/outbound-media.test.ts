/**
 * Outbound media coverage for the WhatsApp connector (#8876): agent attachments
 * ship as native WhatsApp media messages via sendMediaMessage, including turns
 * that carry attachments with empty text. Both transports (Cloud API + Baileys)
 * build their payload from the same WhatsAppMessage media type, so one path
 * covers both. Mocked runtime — runs offline.
 */
import type { IAgentRuntime, Media, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { WhatsAppConnectorService } from "../src/runtime-service";

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
});

describe("WhatsApp sendMediaMessage — transport-agnostic media call", () => {
  function realServiceWithClient() {
    const clientSend = vi.fn(async () => ({ messages: [{ id: "x" }] }));
    const svc = Object.create(
      WhatsAppConnectorService.prototype,
    ) as WhatsAppConnectorService & {
      getClientForAccount: ReturnType<typeof vi.fn>;
      sendMediaMessage: (
        accountId: string | null | undefined,
        to: string,
        media: Media,
      ) => Promise<void>;
    };
    (svc as { getClientForAccount: unknown }).getClientForAccount = vi.fn(() => ({
      sendMessage: clientSend,
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
});
