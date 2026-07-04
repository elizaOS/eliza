/**
 * Verifies the Nostr connector appends agent-generated attachments as inline
 * URLs in note/DM text rather than dropping them (#8876). Mocked send paths —
 * runs offline.
 */
import type { Content, IAgentRuntime, TargetInfo } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { NostrService } from "../service.js";

// Nostr has no separate attachment field: kind:1 notes and DMs carry media as
// URLs in the content, which clients render inline — hence the URL-append path.

function runtime(): IAgentRuntime {
  return {
    agentId: "agent-1",
    character: { settings: {} },
    emitEvent: vi.fn(),
    getSetting: vi.fn(() => null),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
}

function service(): NostrService {
  const instance = Object.create(NostrService.prototype) as NostrService;
  Object.assign(instance, {
    runtime: runtime(),
    accountServices: new Map(),
    connected: true,
    seenEventIds: new Set(),
    settings: {
      accountId: "default",
      privateKey: "1".repeat(64),
      publicKey: "2".repeat(64),
      relays: ["wss://relay.example"],
      dmPolicy: "open",
      allowFrom: [],
      enabled: true,
    },
    privateKey: new Uint8Array(32).fill(1),
    pool: { publish: vi.fn(async () => undefined), querySync: vi.fn(async () => []) },
  });
  return instance;
}

const PUBKEY = "a".repeat(64);
const target = { source: "nostr", channelId: PUBKEY } as TargetInfo;

describe("Nostr outbound media (URLs in content)", () => {
  it("appends an attachment URL to a DM instead of dropping it", async () => {
    const svc = service();
    const sendDm = vi.spyOn(svc, "sendDm").mockResolvedValue({ success: true } as never);

    await svc.handleSendMessage(runtime(), target, {
      text: "here you go",
      attachments: [{ id: "img", url: "https://cdn.example.com/cat.png", contentType: "image" }],
    } as Content);

    expect(sendDm).toHaveBeenCalledTimes(1);
    const arg = sendDm.mock.calls[0][0] as { text: string };
    expect(arg.text).toContain("here you go");
    expect(arg.text).toContain("https://cdn.example.com/cat.png");
  });

  it("appends an attachment URL to a public note", async () => {
    const svc = service();
    const publishNote = vi
      .spyOn(svc, "publishNote")
      .mockResolvedValue({ success: true, eventId: "e".repeat(64) } as never);
    vi.spyOn(
      svc as unknown as { nostrEventToPostMemory: () => unknown },
      "nostrEventToPostMemory"
    ).mockReturnValue({} as never);

    await svc.handleSendPost(runtime(), {
      text: "check this",
      attachments: [{ id: "vid", url: "https://cdn.example.com/clip.mp4", contentType: "video" }],
    } as Content);

    expect(publishNote).toHaveBeenCalledTimes(1);
    expect(publishNote.mock.calls[0][0]).toContain("https://cdn.example.com/clip.mp4");
  });

  it("allows an attachment-only DM (no text) — the URL becomes the content", async () => {
    const svc = service();
    const sendDm = vi.spyOn(svc, "sendDm").mockResolvedValue({ success: true } as never);

    await svc.handleSendMessage(runtime(), target, {
      text: "",
      attachments: [{ id: "img", url: "https://cdn.example.com/cat.png", contentType: "image" }],
    } as Content);

    expect(sendDm).toHaveBeenCalledTimes(1);
    expect((sendDm.mock.calls[0][0] as { text: string }).text).toContain(
      "https://cdn.example.com/cat.png"
    );
  });

  it("still rejects a DM with neither text nor attachments", async () => {
    const svc = service();
    const sendDm = vi.spyOn(svc, "sendDm");
    await expect(
      svc.handleSendMessage(runtime(), target, { text: "   " } as Content)
    ).rejects.toThrow("requires non-empty text");
    expect(sendDm).not.toHaveBeenCalled();
  });
});
