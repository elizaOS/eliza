/**
 * Unit coverage for the Telegram membership admission gate's degradation
 * semantics: a deployment without a membership authority service degrades to
 * allow with a once-per-chat warning (availability), while
 * TELEGRAM_MEMBERSHIP_ENFORCE=1 opts into strict fail-closed admission
 * (security). Deterministic unit harness; the real-PGlite authority vertical
 * lives in __tests__/membership-authority.real.test.ts.
 */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramMembershipMessageGate } from "./membership-gate";

function gateRuntime() {
  return {
    agentId: "agent-1",
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
}

function decisionInput(overrides?: {
  telegramUserId?: string;
}): Parameters<TelegramMembershipMessageGate["authorizeMessage"]>[0] {
  return {
    chatId: "-100",
    chatRoomKey: "-100",
    chatType: "group",
    principalEntityId: "00000000-0000-0000-0000-000000000001" as UUID,
    telegramUserId: overrides?.telegramUserId ?? "42",
    runtimeMapping: {
      worldId: null,
      roomId: null,
      entityId: null,
    },
    getChatMember: async () => ({ status: "member", user: { id: 42 } }),
  };
}

const ORIGINAL_ENFORCE = process.env.TELEGRAM_MEMBERSHIP_ENFORCE;

afterEach(() => {
  if (ORIGINAL_ENFORCE === undefined) {
    delete process.env.TELEGRAM_MEMBERSHIP_ENFORCE;
  } else {
    process.env.TELEGRAM_MEMBERSHIP_ENFORCE = ORIGINAL_ENFORCE;
  }
});

describe("TelegramMembershipMessageGate without an authority service", () => {
  it("degrades to allow group admission with a warning (availability)", async () => {
    delete process.env.TELEGRAM_MEMBERSHIP_ENFORCE;
    const gate = new TelegramMembershipMessageGate({
      runtime: gateRuntime(),
      authority: null,
      botTelegramUserId: null,
    });
    await expect(gate.authorizeMessage(decisionInput())).resolves.toBe(true);
  });

  it("fails closed when TELEGRAM_MEMBERSHIP_ENFORCE=1 opts into strict mode", async () => {
    process.env.TELEGRAM_MEMBERSHIP_ENFORCE = "1";
    const gate = new TelegramMembershipMessageGate({
      runtime: gateRuntime(),
      authority: null,
      botTelegramUserId: null,
    });
    await expect(gate.authorizeMessage(decisionInput())).resolves.toBe(false);
  });

  it.each(["true", "yes", "y", "on", "enabled"])(
    "fails closed for the canonical truthy spelling %s (isTruthyEnvValue parity)",
    async (spelling) => {
      process.env.TELEGRAM_MEMBERSHIP_ENFORCE = spelling;
      const gate = new TelegramMembershipMessageGate({
        runtime: gateRuntime(),
        authority: null,
        botTelegramUserId: null,
      });
      await expect(gate.authorizeMessage(decisionInput())).resolves.toBe(false);
    },
  );

  it("fails closed for TELEGRAM_MEMBERSHIP_ENFORCE with surrounding whitespace or mixed case", async () => {
    process.env.TELEGRAM_MEMBERSHIP_ENFORCE = "  TRUE \n";
    const gate = new TelegramMembershipMessageGate({
      runtime: gateRuntime(),
      authority: null,
      botTelegramUserId: null,
    });
    await expect(gate.authorizeMessage(decisionInput())).resolves.toBe(false);
  });

  it.each(["0", "false", "no", "off", "", "enable", "totally"])(
    "degrades to allow for the non-truthy value %s (no strict opt-in)",
    async (value) => {
      process.env.TELEGRAM_MEMBERSHIP_ENFORCE = value;
      const gate = new TelegramMembershipMessageGate({
        runtime: gateRuntime(),
        authority: null,
        botTelegramUserId: null,
      });
      await expect(gate.authorizeMessage(decisionInput())).resolves.toBe(true);
    },
  );

  it("warns once per chat, not per message", async () => {
    delete process.env.TELEGRAM_MEMBERSHIP_ENFORCE;
    const runtime = gateRuntime();
    const gate = new TelegramMembershipMessageGate({
      runtime,
      authority: null,
      botTelegramUserId: null,
    });
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    // Unique chat ids + message+context filtering: the structured logger
    // flushes asynchronously, so calls buffered by earlier tests can land
    // while this spy is attached and must not be counted.
    const absentWarns = (chatId: string) =>
      warnSpy.mock.calls.filter(
        (call) =>
          call[call.length - 1] ===
            "Telegram group admission running without a membership authority service; membership checks disabled" &&
          (call[0] as { chatId?: string })?.chatId === chatId,
      );
    try {
      const first = decisionInput();
      first.chatId = "-9101";
      first.chatRoomKey = "-9101";
      const sameChatOtherSender = decisionInput({ telegramUserId: "43" });
      sameChatOtherSender.chatId = "-9101";
      sameChatOtherSender.chatRoomKey = "-9101";
      await gate.authorizeMessage(first);
      await gate.authorizeMessage(first);
      await gate.authorizeMessage(sameChatOtherSender);
      expect(absentWarns("-9101").length).toBe(1);
      // A different chat warns independently.
      const otherChat = decisionInput();
      otherChat.chatId = "-9102";
      otherChat.chatRoomKey = "-9102";
      await gate.authorizeMessage(otherChat);
      expect(absentWarns("-9102").length).toBe(1);
      expect(absentWarns("-9101").length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("fails closed after markBroken (authority configured but bootstrap failed)", async () => {
    delete process.env.TELEGRAM_MEMBERSHIP_ENFORCE;
    const gate = new TelegramMembershipMessageGate({
      runtime: gateRuntime(),
      authority: null,
      botTelegramUserId: null,
    });
    gate.markBroken();
    await expect(gate.authorizeMessage(decisionInput())).resolves.toBe(false);
  });

  it("admits the bot's own messages without consulting any authority", async () => {
    const gate = new TelegramMembershipMessageGate({
      runtime: gateRuntime(),
      authority: null,
      botTelegramUserId: "900001",
    });
    await expect(
      gate.authorizeMessage(decisionInput({ telegramUserId: "900001" })),
    ).resolves.toBe(true);
  });
});
