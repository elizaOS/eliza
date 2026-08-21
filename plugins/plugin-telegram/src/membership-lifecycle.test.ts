/** Unit coverage for Telegram removal and reconnect classification. */
import { describe, expect, it } from "vitest";
import { classifyTelegramMembershipTransition } from "./membership-lifecycle";

describe("Telegram bot membership lifecycle", () => {
  it("suspends on leave or kick", () => {
    expect(classifyTelegramMembershipTransition("member", "left")).toBe("left");
    expect(
      classifyTelegramMembershipTransition("administrator", "kicked"),
    ).toBe("left");
  });

  it("reconnects the same world when re-added", () => {
    expect(classifyTelegramMembershipTransition("left", "member")).toBe(
      "connected",
    );
    expect(
      classifyTelegramMembershipTransition("kicked", "administrator"),
    ).toBe("connected");
  });

  it("treats permission changes as updates and ignores no-op updates", () => {
    expect(
      classifyTelegramMembershipTransition("member", "administrator"),
    ).toBe("updated");
    expect(classifyTelegramMembershipTransition("member", "member")).toBeNull();
  });
});
