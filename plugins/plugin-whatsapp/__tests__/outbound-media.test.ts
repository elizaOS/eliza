/**
 * Outbound media coverage for the WhatsApp connector (#8876): agent attachments
 * ship as native WhatsApp media messages via sendMediaMessage, including turns
 * that carry attachments with empty text through the direct Baileys seam.
 * Mocked runtime — runs offline.
 */
import type { IAgentRuntime, Media, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { WhatsAppConnectorService } from "../src/runtime-service";

const mediaMocks = vi.hoisted(() => ({
  stageWhatsAppMedia: vi.fn(async () => ({
    buffer: Buffer.from("guarded-media"),
    contentType: "application/octet-stream",
  })),
}));

vi.mock("../src/media", async (importActual) => ({
  ...(await importActual<typeof import("../src/media")>()),
  stageWhatsAppMedia: mediaMocks.stageWhatsAppMedia,
}));

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
    config: { authDir: "/tmp/whatsapp-test" },
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

  it("rejects the connector operation when attachment delivery fails", async () => {
    const registrations: MessageConnectorRegistration[] = [];
    const runtime = makeRuntime(registrations);
    const service = mockService();
    vi.mocked(service.sendMediaMessage).mockRejectedValueOnce(new Error("media delivery failed"));
    WhatsAppConnectorService.registerSendHandlers(runtime, service);

    await expect(
      registrations[0].sendHandler?.(runtime, TARGET, {
        text: "",
        attachments: [{ id: "img", url: "https://cdn.example.com/cat.png" }],
      } as ConnectorContent),
    ).rejects.toThrow("media delivery failed");
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
      ) => Promise<void>;
    };
    (svc as { getClientForAccount: unknown }).getClientForAccount = vi.fn(() => ({
      sendMessage: clientSend,
    }));
    (svc as { getConfigForAccount: unknown }).getConfigForAccount = vi.fn(() => null);
    (svc as unknown as { runtime: IAgentRuntime }).runtime = {
      fetch: vi.fn(),
    } as never as IAgentRuntime;
    return { svc, clientSend };
  }

  it("maps coarse content type and gives the client only guarded bytes", async () => {
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
      content: {
        data: Buffer.from("guarded-media"),
        mimeType: "application/octet-stream",
        caption: "a cat",
      },
    });
    expect(mediaMocks.stageWhatsAppMedia).toHaveBeenCalledWith(
      "https://cdn.example.com/cat.png",
      expect.objectContaining({ maxBytes: 20 * 1024 * 1024 }),
      expect.any(Function),
    );
  });

  it("reads a canonical content-addressed handle only through runtime.fetch", async () => {
    const { svc, clientSend } = realServiceWithClient();
    const storedUrl = `/api/media/${"a".repeat(64)}.png`;
    const runtimeFetch = vi.fn(async () =>
      new Response(Buffer.from("stored-media"), {
        headers: { "content-type": "image/png", "content-length": "12" },
      }),
    );
    (svc as unknown as { runtime: IAgentRuntime }).runtime = {
      fetch: runtimeFetch,
    } as never as IAgentRuntime;
    mediaMocks.stageWhatsAppMedia.mockImplementationOnce(async (_url, _options, localFetch) => {
      const response = await localFetch?.(storedUrl);
      return { buffer: Buffer.from(await response!.arrayBuffer()), contentType: "image/png" };
    });

    await svc.sendMediaMessage("default", "+14155552671", {
      id: "stored",
      url: storedUrl,
      mimeType: "image/png",
    } as Media);

    expect(mediaMocks.stageWhatsAppMedia).toHaveBeenCalledWith(
      storedUrl,
      expect.objectContaining({ maxBytes: 20 * 1024 * 1024 }),
      runtimeFetch,
    );
    expect(clientSend).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.objectContaining({ data: Buffer.from("stored-media") }) }),
    );
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
        data: Buffer.from("guarded-media"),
        mimeType: "application/octet-stream",
        filename: "report.pdf",
      },
    });
  });
});
