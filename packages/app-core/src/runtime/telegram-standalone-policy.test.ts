import { describe, expect, it } from "vitest";
import { shouldStartTelegramStandaloneBot } from "./telegram-standalone-policy";

describe("shouldStartTelegramStandaloneBot", () => {
  it("keeps the standalone Telegram responder off by default", () => {
    expect(shouldStartTelegramStandaloneBot({})).toBe(false);
  });

  it("requires passive LifeOps connector mode to be disabled", () => {
    expect(
      shouldStartTelegramStandaloneBot({
        MILADY_TELEGRAM_STANDALONE_BOT: "1",
      }),
    ).toBe(false);
  });

  it("allows explicit standalone mode after passive connectors are disabled", () => {
    expect(
      shouldStartTelegramStandaloneBot({
        MILADY_LIFEOPS_PASSIVE_CONNECTORS: "0",
        MILADY_TELEGRAM_STANDALONE_BOT: "1",
      }),
    ).toBe(true);
  });
});
