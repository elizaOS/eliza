import { describe, expect, it } from "vitest";
import { isDiscordDmSenderAllowed } from "./discord-dm-policy.ts";

describe("isDiscordDmSenderAllowed", () => {
  it("allows everyone when the policy is open (default)", () => {
    expect(isDiscordDmSenderAllowed({}, "anyone")).toBe(true);
    expect(isDiscordDmSenderAllowed({ dmPolicy: "open" }, "stranger")).toBe(
      true,
    );
  });

  it("denies everyone when disabled", () => {
    expect(isDiscordDmSenderAllowed({ dmPolicy: "disabled" }, "owner-1")).toBe(
      false,
    );
  });

  it("allowlist admits listed ids and owner ids", () => {
    const meta = {
      dmPolicy: "allowlist" as const,
      dmAllowFrom: ["friend-1"],
      ownerDiscordUserId: "owner-1",
    };
    expect(isDiscordDmSenderAllowed(meta, "friend-1")).toBe(true);
    expect(isDiscordDmSenderAllowed(meta, "owner-1")).toBe(true);
    expect(isDiscordDmSenderAllowed(meta, "stranger")).toBe(false);
  });

  it("pairing admits only owner ids (no external allowlist)", () => {
    const meta = {
      dmPolicy: "pairing" as const,
      ownerDiscordUserId: "owner-1",
      dmAllowFrom: ["friend-1"],
    };
    expect(isDiscordDmSenderAllowed(meta, "owner-1")).toBe(true);
    // pairing 不读 dmAllowFrom
    expect(isDiscordDmSenderAllowed(meta, "friend-1")).toBe(false);
  });

  it("supports ownerDiscordUserIds array", () => {
    const meta = {
      dmPolicy: "pairing" as const,
      ownerDiscordUserIds: ["a", "b"],
    };
    expect(isDiscordDmSenderAllowed(meta, "a")).toBe(true);
    expect(isDiscordDmSenderAllowed(meta, "b")).toBe(true);
    expect(isDiscordDmSenderAllowed(meta, "c")).toBe(false);
  });
});
