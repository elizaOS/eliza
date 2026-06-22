// Outbound MEDIA coverage for the iMessage connector (#8876).
//
// The agent generates/forwards audio, image, video, pdf, etc. attachments, and
// the iMessage connector must carry those out — not silently drop them. Two
// layers are covered here, mirroring the other connectors' outbound-media tests:
//
//   1. Connector dispatch: the registered `sendHandler` extracts the first
//      attachment URL from Content and passes it to `sendMessage({ mediaUrl })`
//      — including the media-only case (no text).
//   2. Send build: a real IMessageService turns `{ mediaUrl }` into an
//      AppleScript that actually attaches the file (`send (POSIX file …)`),
//      with `file://` URLs normalised to POSIX paths. The osascript exec is
//      stubbed, so nothing is sent — we assert the connector BUILDS the right
//      attach command.
import type { Content, IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { IMessageService } from "../src/service.js";
import type { IMessageServiceStatus } from "../src/types.js";

type RuntimeSendHandler = Parameters<IAgentRuntime["registerSendHandler"]>[1];
type ConnectorTargetInfo = Parameters<RuntimeSendHandler>[1];
type ConnectorContent = Parameters<RuntimeSendHandler>[2];
type MessageConnectorRegistration = Parameters<IAgentRuntime["registerMessageConnector"]>[0];

function makeStatus(): IMessageServiceStatus {
  return {
    available: true,
    connected: true,
    chatDbAvailable: true,
    sendOnly: false,
    chatDbPath: "/tmp/chat.db",
    reason: null,
    permissionAction: null,
  };
}

function makeRuntime(registrations: MessageConnectorRegistration[]): IAgentRuntime {
  return {
    agentId: "agent-1" as UUID,
    registerMessageConnector: vi.fn((registration: MessageConnectorRegistration) => {
      registrations.push(registration);
    }),
    registerSendHandler: vi.fn(),
    emitEvent: vi.fn(),
    getRoom: vi.fn(async () => null),
    getMemoryById: vi.fn(async () => null),
  } as unknown as IAgentRuntime;
}

describe("iMessage connector — outbound media dispatch", () => {
  it("passes the first attachment URL through to sendMessage as mediaUrl", async () => {
    const registrations: MessageConnectorRegistration[] = [];
    const runtime = makeRuntime(registrations);
    const service = {
      getStatus: vi.fn(makeStatus),
      getContacts: vi.fn(() => new Map()),
      getChats: vi.fn(async () => []),
      getRecentMessages: vi.fn(async () => []),
      getMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async () => ({ success: true, messageId: "msg-1" })),
    } as unknown as IMessageService;

    IMessageService.registerSendHandlers(runtime, service);

    await registrations[0].sendHandler(
      runtime,
      { source: "imessage", entityId: "+1 (415) 555-2671" as UUID } as ConnectorTargetInfo,
      {
        text: "here is the file",
        attachments: [{ id: "a1", url: "/media/generated-speech.mp3", contentType: "audio" }],
      } as unknown as ConnectorContent
    );

    expect(service.sendMessage).toHaveBeenCalledWith("+14155552671", "here is the file", {
      mediaUrl: "/media/generated-speech.mp3",
      accountId: "default",
    });
  });

  it("dispatches a media-only message (no text) instead of dropping it", async () => {
    const registrations: MessageConnectorRegistration[] = [];
    const runtime = makeRuntime(registrations);
    const service = {
      getStatus: vi.fn(makeStatus),
      getContacts: vi.fn(() => new Map()),
      getChats: vi.fn(async () => []),
      getRecentMessages: vi.fn(async () => []),
      getMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async () => ({ success: true, messageId: "msg-1" })),
    } as unknown as IMessageService;

    IMessageService.registerSendHandlers(runtime, service);

    await registrations[0].sendHandler(
      runtime,
      { source: "imessage", entityId: "+1 (415) 555-2671" as UUID } as ConnectorTargetInfo,
      {
        text: "",
        attachments: [{ id: "img", url: "/media/pic.png", contentType: "image" }],
      } as unknown as ConnectorContent
    );

    expect(service.sendMessage).toHaveBeenCalledWith("+14155552671", "", {
      mediaUrl: "/media/pic.png",
      accountId: "default",
    });
  });

  it("sends nothing when there is neither text nor an attachment", async () => {
    const registrations: MessageConnectorRegistration[] = [];
    const runtime = makeRuntime(registrations);
    const service = {
      getStatus: vi.fn(makeStatus),
      getContacts: vi.fn(() => new Map()),
      getChats: vi.fn(async () => []),
      getRecentMessages: vi.fn(async () => []),
      getMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async () => ({ success: true, messageId: "msg-1" })),
    } as unknown as IMessageService;

    IMessageService.registerSendHandlers(runtime, service);

    await registrations[0].sendHandler(
      runtime,
      { source: "imessage", entityId: "+1 (415) 555-2671" as UUID } as ConnectorTargetInfo,
      { text: "   ", attachments: [] } as unknown as ConnectorContent
    );

    expect(service.sendMessage).not.toHaveBeenCalled();
  });
});

describe("iMessage service — media → AppleScript attachment build", () => {
  function makeService(): {
    svc: IMessageService;
    scripts: string[];
  } {
    const runtime = {
      agentId: "agent-1" as UUID,
      emitEvent: vi.fn(),
    } as unknown as IAgentRuntime;
    const svc = new IMessageService(runtime);
    // Inject the runtime + minimal settings (AppleScript path: cliPath "imsg").
    (svc as unknown as { runtime: IAgentRuntime }).runtime = runtime;
    (svc as unknown as { settings: unknown }).settings = {
      cliPath: "imsg",
      pollIntervalMs: 0,
      dmPolicy: "open",
      groupPolicy: "open",
    };
    // Stub the osascript exec seam — capture every script, send nothing.
    const scripts: string[] = [];
    (svc as unknown as { runAppleScript: (s: string) => Promise<string> }).runAppleScript = vi.fn(
      async (s: string) => {
        scripts.push(s);
        return "";
      }
    );
    return { svc, scripts };
  }

  it("emits a `send (POSIX file …)` attachment script for a media send", async () => {
    const { svc, scripts } = makeService();

    const result = await svc.sendMessage("+14155552671", "caption", {
      mediaUrl: "/Users/me/Library/media/clip.mp3",
    });

    expect(result.success).toBe(true);
    // One script for the text body, one for the attachment.
    expect(scripts).toHaveLength(2);
    const attachmentScript = scripts.find((s) => s.includes("POSIX file"));
    expect(attachmentScript).toBeDefined();
    expect(attachmentScript).toContain("/Users/me/Library/media/clip.mp3");
  });

  it("normalises a file:// media URL to a POSIX path", async () => {
    const { svc, scripts } = makeService();

    await svc.sendMessage("+14155552671", "", {
      mediaUrl: "file:///tmp/generated.png",
    });

    // Media-only send → exactly one (attachment) script, no text script.
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("POSIX file");
    expect(scripts[0]).toContain("/tmp/generated.png");
    expect(scripts[0]).not.toContain("file://");
  });

  it("marks the outbound event as hasMedia when a mediaUrl is present", async () => {
    const runtime = {
      agentId: "agent-1" as UUID,
      emitEvent: vi.fn(),
    } as unknown as IAgentRuntime;
    const svc = new IMessageService(runtime);
    (svc as unknown as { runtime: IAgentRuntime }).runtime = runtime;
    (svc as unknown as { settings: unknown }).settings = {
      cliPath: "imsg",
      pollIntervalMs: 0,
      dmPolicy: "open",
      groupPolicy: "open",
    };
    (svc as unknown as { runAppleScript: (s: string) => Promise<string> }).runAppleScript = vi.fn(
      async () => ""
    );

    await svc.sendMessage("+14155552671", "x", { mediaUrl: "/m/a.png" });

    const emit = runtime.emitEvent as unknown as ReturnType<typeof vi.fn>;
    const hasMediaCall = emit.mock.calls.find(
      (c) => (c[1] as Content & { hasMedia?: boolean })?.hasMedia === true
    );
    expect(hasMediaCall).toBeDefined();
  });
});
