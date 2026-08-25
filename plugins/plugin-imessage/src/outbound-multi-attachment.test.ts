/**
 * Multi-attachment delivery truth for the iMessage connector (#23104).
 * sendMessage must attempt EVERY requested attachment — never a first-only
 * selection — resolve all bytes before the first external send, and clean up
 * every staged temp directory on every exit path. The AppleScript seams are
 * stubbed so the suite runs offline with no Messages.app.
 */

import { describe, expect, it, vi } from "vitest";
import { IMessageService } from "./service";

function createService(overrides?: {
  resolveOutboundMedia?: (url: string) => Promise<{ path: string; cleanup: () => Promise<void> }>;
  sendResolvedAttachment?: (
    to: string,
    path: string
  ) => Promise<{ success: boolean; error?: string }>;
}) {
  const cleanedPaths: string[] = [];
  const sendAttachmentCalls: Array<{ to: string; path: string }> = [];
  const sendTextCalls: Array<{ to: string; text: string }> = [];
  const resolveCalls: string[] = [];
  let seq = 0;
  const service = Object.create(IMessageService.prototype) as IMessageService & {
    settings: unknown;
    sendMessage: IMessageService["sendMessage"];
    resolveOutboundMedia: (
      url: string,
      maxBytes?: number
    ) => Promise<{ path: string; cleanup: () => Promise<void> }>;
    sendResolvedAttachment: (
      to: string,
      path: string
    ) => Promise<{ success: boolean; error?: string }>;
    sendSingleMessage: (to: string, text: string) => Promise<{ success: boolean; error?: string }>;
  };
  Object.assign(service, {
    settings: { pollIntervalMs: 0 },
    resolveOutboundMedia:
      overrides?.resolveOutboundMedia ??
      (vi.fn(async (url: string) => {
        resolveCalls.push(url);
        seq += 1;
        return {
          path: `/tmp/staged-${seq}-${url.split("/").pop()}`,
          cleanup: async () => {
            cleanedPaths.push(`/tmp/staged-${seq}-${url.split("/").pop()}`);
          },
        };
      }) as unknown as IMessageService extends never ? never : typeof service.resolveOutboundMedia),
    sendResolvedAttachment: async (to: string, path: string) => {
      sendAttachmentCalls.push({ to, path });
      if (overrides?.sendResolvedAttachment) {
        return overrides.sendResolvedAttachment(to, path);
      }
      return { success: true };
    },
    sendSingleMessage: vi.fn(async (to: string, text: string) => {
      sendTextCalls.push({ to, text });
      return { success: true, messageId: `m-${sendTextCalls.length}` };
    }),
  });
  return {
    service,
    sendAttachmentCalls,
    sendTextCalls,
    cleanedPaths,
    resolveCalls,
  };
}

describe("iMessage multi-attachment delivery", () => {
  it("sends every requested attachment, not only the first", async () => {
    const h = createService();
    const result = await h.service.sendMessage("+155****1111", "two files", {
      mediaUrls: ["https://x/first.png", "https://x/second.png"],
    });

    expect(result.success).toBe(true);
    expect(h.sendAttachmentCalls).toHaveLength(2);
    expect(h.sendAttachmentCalls[0]?.path).toContain("first");
    expect(h.sendAttachmentCalls[1]?.path).toContain("second");
  });

  it("resolves ALL attachment bytes before the first external send", async () => {
    const cleanedOkStaging: string[] = [];
    const h = createService({
      resolveOutboundMedia: (url: string) => {
        if (url.includes("bad")) {
          return Promise.reject(new Error("ssrf blocked"));
        }
        return Promise.resolve({
          path: "/tmp/ok",
          cleanup: async () => {
            cleanedOkStaging.push(url);
          },
        });
      },
    });

    const result = await h.service.sendMessage("+155****1111", "caption", {
      // good resolves FIRST, then bad rejects: the already-staged good file
      // must be cleaned up by the fail-fast path rather than leaked.
      mediaUrls: ["https://x/good.png", "https://x/bad.png"],
    });

    // Fail fast: nothing reached Messages.app, and the earlier staged file
    // was cleaned up rather than leaked.
    expect(result.success).toBe(false);
    expect(result.error).toContain("attachment resolution error");
    expect(h.sendTextCalls).toHaveLength(0);
    expect(h.sendAttachmentCalls).toHaveLength(0);
    expect(cleanedOkStaging).toEqual(["https://x/good.png"]);
  });

  it("reports delivered-part evidence when a later attachment fails after text went out", async () => {
    let sendCount = 0;
    const h = createService({
      sendResolvedAttachment: async () => {
        sendCount += 1;
        if (sendCount === 2) {
          return { success: false, error: "AppleScript attachment error: boom" };
        }
        return { success: true };
      },
    });

    const result = await h.service.sendMessage("+155****1111", "caption", {
      mediaUrls: ["https://x/a.png", "https://x/b.png"],
    });

    expect(result.success).toBe(false);
    expect(result.delivered).toBeDefined();
    expect(result.delivered?.textChunks).toBe(1);
    expect(result.delivered?.attachments).toBe(1);
    expect(result.delivered?.effectStamps).toHaveLength(2);
  });

  it("never lets a staging-cleanup rejection fail an already-delivered send (J6)", async () => {
    const h = createService({
      resolveOutboundMedia: async (url: string) => ({
        path: `/tmp/staged-${url.split("/").pop()}`,
        cleanup: async () => {
          throw new Error("EBUSY: directory in use");
        },
      }),
    });

    const result = await h.service.sendMessage("+155****1111", "caption", {
      mediaUrls: ["https://x/a.png"],
    });

    // Delivery already succeeded; cleanup failure is diagnostic only.
    expect(result.success).toBe(true);
  });

  it("cleans up every staged directory when a later attachment fails to send", async () => {
    let sendCount = 0;
    const h = createService({
      sendResolvedAttachment: async (_to, _path) => {
        sendCount += 1;
        if (sendCount === 2) {
          return { success: false, error: "AppleScript attachment error: boom" };
        }
        return { success: true };
      },
    });

    const result = await h.service.sendMessage("+155****1111", "caption", {
      mediaUrls: ["https://x/a.png", "https://x/b.png", "https://x/c.png"],
    });

    expect(result.success).toBe(false);
    expect(h.sendAttachmentCalls).toHaveLength(2); // c was never attempted after b failed
    // All staged dirs cleaned: both resolved-before-send attachments.
    expect(h.cleanedPaths).toHaveLength(3);
  });

  it("keeps single-attachment sends working (regression of the common path)", async () => {
    const h = createService();
    const result = await h.service.sendMessage("+155****1111", "one file", {
      mediaUrls: ["https://x/only.png"],
    });

    expect(result.success).toBe(true);
    expect(h.sendAttachmentCalls).toHaveLength(1);
    expect(h.cleanedPaths).toHaveLength(1);
  });

  it("stamps every delivered part with a per-send unique local-effect marker (#23104 review blocker 3)", async () => {
    // Two sends, each failing partway so delivered.effectStamps is returned.
    // Stamps must be unique within a send AND across sends: AppleScript
    // returns no provider ids, so a repeatable counter like "text-1" would
    // masquerade as reconcilable provider evidence.
    const failAfterText = {
      sendResolvedAttachment: async () => ({ success: false, error: "boom" }),
    };
    const first = createService(failAfterText);
    const second = createService(failAfterText);
    const one = await first.service.sendMessage("+155****1111", "first send", {
      mediaUrls: ["https://x/a.png"],
    });
    const two = await second.service.sendMessage("+155****1111", "second send", {
      mediaUrls: ["https://x/b.png"],
    });

    for (const result of [one, two]) {
      expect(result.success).toBe(false);
      expect(result.delivered?.effectStamps).toHaveLength(1);
      for (const stamp of result.delivered?.effectStamps ?? []) {
        expect(stamp).toMatch(/^imessage-effect:[0-9a-f-]{36}:(text|attachment):\d+$/);
      }
    }
    const oneStamps = one.delivered?.effectStamps ?? [];
    const twoStamps = two.delivered?.effectStamps ?? [];
    expect(new Set([...oneStamps, ...twoStamps]).size).toBe(oneStamps.length + twoStamps.length);
  });
});
