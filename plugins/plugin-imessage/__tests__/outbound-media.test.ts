/**
 * Outbound media contract tests for connector dispatch and the real native
 * Messages AppleScript builder. The harness stubs only osascript, while file
 * validation, bounded local-media fetching, temporary staging, cleanup, and
 * text-chunk attachment cardinality execute through production code.
 */
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
    // Inject the runtime + minimal native settings.
    (svc as unknown as { runtime: IAgentRuntime }).runtime = runtime;
    (svc as unknown as { settings: unknown }).settings = {
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
    const fixtureDir = await mkdtemp(join(tmpdir(), "imessage-media-test-"));
    const fixturePath = join(fixtureDir, "clip.mp3");
    await writeFile(fixturePath, "media");
    try {
      const result = await svc.sendMessage("+14155552671", "caption", {
        mediaUrl: fixturePath,
      });

      expect(result.success).toBe(true);
      // One script for the text body, one for the attachment.
      expect(scripts).toHaveLength(2);
      const attachmentScript = scripts.find((s) => s.includes("POSIX file"));
      expect(attachmentScript).toBeDefined();
      const stagedPath = /POSIX file "([^"]+)"/.exec(attachmentScript ?? "")?.[1] ?? "";
      expect(stagedPath).toContain("eliza-imessage-");
      expect(stagedPath.endsWith("attachment.mp3")).toBe(true);
      expect(attachmentScript).not.toContain(fixturePath);
      await expect(stat(stagedPath)).rejects.toThrow();
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("stays on the built-in AppleScript transport", async () => {
    const { svc, scripts } = makeService();

    const result = await svc.sendMessage("+14155552671", "native only");

    expect(result.success).toBe(true);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('tell application "Messages"');
    expect(scripts[0]).toContain("native only");
  });

  it("normalises a file:// media URL to a POSIX path", async () => {
    const { svc, scripts } = makeService();
    const fixtureDir = await mkdtemp(join(tmpdir(), "imessage-media-test-"));
    const fixturePath = join(fixtureDir, "generated image.png");
    await writeFile(fixturePath, "media");
    try {
      await svc.sendMessage("+14155552671", "", {
        mediaUrl: pathToFileURL(fixturePath).href,
      });

      // Media-only send → exactly one (attachment) script, no text script.
      expect(scripts).toHaveLength(1);
      expect(scripts[0]).toContain("POSIX file");
      const stagedPath = /POSIX file "([^"]+)"/.exec(scripts[0])?.[1] ?? "";
      expect(stagedPath).toContain("eliza-imessage-");
      expect(stagedPath.endsWith("attachment.png")).toBe(true);
      expect(scripts[0]).not.toContain(fixturePath);
      expect(scripts[0]).not.toContain("file://");
      await expect(stat(stagedPath)).rejects.toThrow();
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("stages a canonical local media-store handle and removes it after osascript", async () => {
    const hash = "a".repeat(64);
    const registrations: MessageConnectorRegistration[] = [];
    const runtime = makeRuntime(registrations);
    runtime.fetch = vi.fn(
      async () =>
        new Response(Buffer.from("stored image"), {
          status: 200,
          headers: {
            "content-length": "12",
            "content-type": "image/png",
          },
        })
    );
    const svc = new IMessageService(runtime);
    (svc as unknown as { settings: unknown }).settings = {
      pollIntervalMs: 0,
      dmPolicy: "open",
      groupPolicy: "open",
    };
    const scripts: string[] = [];
    let stagedPath = "";
    (svc as unknown as { runAppleScript: (s: string) => Promise<string> }).runAppleScript = vi.fn(
      async (script: string) => {
        scripts.push(script);
        stagedPath = /POSIX file "([^"]+)"/.exec(script)?.[1] ?? "";
        expect(stagedPath).toContain("eliza-imessage-");
        return "";
      }
    );

    const result = await svc.sendMessage("+14155552671", "", {
      mediaUrl: `/api/media/${hash}.png`,
    });

    expect(result.success).toBe(true);
    expect(runtime.fetch).toHaveBeenCalledOnce();
    expect(scripts).toHaveLength(1);
    await expect(stat(stagedPath)).rejects.toThrow();
  });

  it("sends one attachment after all chunks instead of duplicating it per chunk", async () => {
    const { svc, scripts } = makeService();
    const fixtureDir = await mkdtemp(join(tmpdir(), "imessage-media-test-"));
    const fixturePath = join(fixtureDir, "one.png");
    await writeFile(fixturePath, "media");
    try {
      const result = await svc.sendMessage("+14155552671", "x".repeat(8_050), {
        mediaUrl: fixturePath,
      });

      expect(result.success).toBe(true);
      expect(scripts.filter((script) => script.includes("POSIX file"))).toHaveLength(1);
      expect(scripts.filter((script) => script.includes('send "'))).toHaveLength(3);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("fails before osascript when a local attachment exceeds maxBytes", async () => {
    const { svc, scripts } = makeService();
    const fixtureDir = await mkdtemp(join(tmpdir(), "imessage-media-test-"));
    const fixturePath = join(fixtureDir, "too-large.bin");
    await writeFile(fixturePath, "oversized");
    try {
      const result = await svc.sendMessage("+14155552671", "caption must not leak", {
        mediaUrl: fixturePath,
        maxBytes: 4,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("exceeds maxBytes 4");
      expect(scripts).toHaveLength(0);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("routes remote attachments through the SSRF guard", async () => {
    const { svc, scripts } = makeService();

    const result = await svc.sendMessage("+14155552671", "", {
      mediaUrl: "http://169.254.169.254/latest/meta-data",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/attachment resolution|blocked|SSRF/i);
    expect(scripts).toHaveLength(0);
  });

  it("marks the outbound event as hasMedia when a mediaUrl is present", async () => {
    const runtime = {
      agentId: "agent-1" as UUID,
      emitEvent: vi.fn(),
    } as unknown as IAgentRuntime;
    const svc = new IMessageService(runtime);
    (svc as unknown as { runtime: IAgentRuntime }).runtime = runtime;
    (svc as unknown as { settings: unknown }).settings = {
      pollIntervalMs: 0,
      dmPolicy: "open",
      groupPolicy: "open",
    };
    (svc as unknown as { runAppleScript: (s: string) => Promise<string> }).runAppleScript = vi.fn(
      async () => ""
    );

    const fixtureDir = await mkdtemp(join(tmpdir(), "imessage-media-test-"));
    const fixturePath = join(fixtureDir, "a.png");
    await writeFile(fixturePath, "media");
    try {
      await svc.sendMessage("+14155552671", "x", { mediaUrl: fixturePath });
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }

    const emit = runtime.emitEvent as unknown as ReturnType<typeof vi.fn>;
    const hasMediaCall = emit.mock.calls.find(
      (c) => (c[1] as Content & { hasMedia?: boolean })?.hasMedia === true
    );
    expect(hasMediaCall).toBeDefined();
  });
});
