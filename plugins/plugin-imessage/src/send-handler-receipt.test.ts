/**
 * Receipt truthfulness for the iMessage send handler (#23104 review
 * blocker 3). AppleScript sends return no provider message ids; the handler
 * must never present local completion markers as provider-backed evidence.
 * This suite captures the REAL sendHandler closure from
 * registerSendHandlers (only service.sendMessage and the runtime registry
 * are stubbed), so it exercises the production receipt-construction path.
 */

import {
  type Content,
  isSendHandlerOutcome,
  type Media,
  type SendHandlerOutcome,
  type TargetInfo,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { IMessageService } from "./service";

type IMessageLike = {
  sendMessage: (
    to: string,
    text: string,
    options?: { mediaUrls?: string[]; accountId?: string; maxBytes?: number }
  ) => Promise<{
    success: boolean;
    messageId?: string;
    chatId?: string;
    error?: string;
    delivered?: { textChunks: number; attachments: number; effectStamps: string[] };
  }>;
};

interface CapturedRegistration {
  source: string;
  sendHandler: (
    runtime: unknown,
    target: TargetInfo,
    content: Content
  ) => Promise<SendHandlerOutcome>;
}

function captureRegistration(service: IMessageLike): CapturedRegistration {
  const registration = { captured: undefined as CapturedRegistration | undefined };
  const runtime = {
    agentId: "agent-1",
    registerMessageConnector: (reg: CapturedRegistration) => {
      registration.captured = reg;
    },
  } as unknown as Parameters<typeof IMessageService.registerSendHandlers>[0];
  IMessageService.registerSendHandlers(
    runtime,
    // The handler only touches sendMessage on the happy paths under test;
    // statusMetadata reads getStatus() once during registration, so supply
    // the minimal surface the real path reaches.
    { sendMessage: service.sendMessage, getStatus: () => ({}) } as unknown as IMessageService
  );
  if (!registration.captured?.sendHandler) {
    throw new Error("sendHandler was not registered");
  }
  return registration.captured;
}

const target: TargetInfo = {
  source: "imessage",
  channelId: "+155****1111",
  accountId: "default",
} as TargetInfo;

function contentWith(text: string, mediaUrls: string[]): Content {
  return {
    text,
    ...(mediaUrls.length > 0
      ? {
          attachments: mediaUrls.map((url, index) => ({ id: `m${index}`, url }) as Media),
        }
      : {}),
  } as Content;
}

describe("iMessage send-handler receipt truthfulness", () => {
  it("marks a delivered receipt as local-effect evidence with a fresh unique stamp, never the service's synthetic messageId", async () => {
    const sendMessage = vi.fn(async () => ({
      success: true,
      // The service's AppleScript path returns a repeatable Date.now() echo;
      // it must NOT become receipt evidence.
      messageId: "1735560000000",
      chatId: "+155****1111",
    }));
    const reg = captureRegistration({ sendMessage });
    const first = await reg.sendHandler(undefined, target, contentWith("hello", []));
    const second = await reg.sendHandler(undefined, target, contentWith("hello again", []));

    for (const outcome of [first, second]) {
      expect(outcome.kind).toBe("delivered");
      expect(isSendHandlerOutcome(outcome)).toBe(true);
      if (outcome.kind !== "delivered") return;
      expect(outcome.receipt.evidenceKind).toBe("local-effect");
      expect(outcome.receipt.providerMessageIds[0]).not.toBe("1735560000000");
      expect(outcome.receipt.providerMessageIds[0]).toMatch(/^imessage-effect:[0-9a-f-]{36}:send$/);
    }
    // Two successful sends in the same millisecond still produce distinct
    // receipt evidence (deterministic collision coverage).
    const ids =
      first.kind === "delivered" && second.kind === "delivered"
        ? [first.receipt.providerMessageIds[0], second.receipt.providerMessageIds[0]]
        : [];
    expect(new Set(ids).size).toBe(2);
  });

  it("exposes stable, per-send-unique local-effect stamps on partial delivery", async () => {
    const sendMessage = vi.fn(async () => ({
      success: false,
      error: "AppleScript attachment error: boom",
      delivered: {
        textChunks: 2,
        attachments: 1,
        effectStamps: [
          "imessage-effect:send-abc:0",
          "imessage-effect:send-abc:1",
          "imessage-effect:send-abc:2",
        ],
      },
    }));
    const reg = captureRegistration({ sendMessage });
    const outcome = await reg.sendHandler(
      undefined,
      target,
      contentWith("two chunks", ["https://x/a.png"])
    );

    expect(outcome.kind).toBe("partially_delivered");
    if (outcome.kind !== "partially_delivered") return;
    expect(outcome.receipt.evidenceKind).toBe("local-effect");
    // Effect stamps must not masquerade as provider ids: they are locally
    // generated completion markers for parts that reached Messages.app.
    expect(
      outcome.receipt.providerMessageIds.every((id) => id.startsWith("imessage-effect:"))
    ).toBe(true);
    expect(outcome.message).toContain("2 text chunk");
    expect(outcome.message).toContain("1 attachment");
  });

  it("passes service-provided effect stamps through verbatim and marks them local-effect", async () => {
    const sendMessage = vi.fn(async () => ({
      success: false,
      error: "AppleScript error: boom",
      delivered: {
        textChunks: 1,
        attachments: 0,
        effectStamps: ["imessage-effect:aaaa1111:text:1"],
      },
    }));
    const reg = captureRegistration({ sendMessage });
    const first = await reg.sendHandler(undefined, target, contentWith("one", []));
    const second = await reg.sendHandler(undefined, target, contentWith("two", []));

    expect(first.kind).toBe("partially_delivered");
    expect(second.kind).toBe("partially_delivered");
    if (second.kind !== "partially_delivered" || first.kind !== "partially_delivered") return;
    // The handler does not re-stamp: service.sendMessage owns per-send
    // uniqueness (asserted in outbound-multi-attachment.test.ts); the handler
    // owns labeling the evidence kind so callers never misread the stamps.
    expect(first.receipt.providerMessageIds).toEqual(["imessage-effect:aaaa1111:text:1"]);
    expect(second.receipt.providerMessageIds).toEqual(["imessage-effect:aaaa1111:text:1"]);
    expect(first.receipt.evidenceKind).toBe("local-effect");
  });

  it("issues a locally generated unique stamp regardless of the service's messageId", async () => {
    const sendMessage = vi.fn(async () => ({
      success: true,
      chatId: "+155****1111",
    }));
    const reg = captureRegistration({ sendMessage });
    const outcome = await reg.sendHandler(undefined, target, contentWith("hello", []));

    expect(outcome.kind).toBe("delivered");
    if (outcome.kind !== "delivered") return;
    expect(outcome.receipt.providerMessageIds).toHaveLength(1);
    // The stamp is never a raw Date.now() echo and never a bare counter: it
    // must be unique per send and clearly labeled as local-effect evidence.
    expect(outcome.receipt.evidenceKind).toBe("local-effect");
    expect(outcome.receipt.providerMessageIds[0]).not.toMatch(/^\d+$/);
  });
});
