import { describe, expect, test } from "vitest";
import { isDiscordDmSenderAllowed } from "./discord-dm-policy";

const OWNER = "111111111111111111";
const CO_OWNER = "222222222222222222";
const FRIEND = "333333333333333333";
const STRANGER = "999999999999999999";

describe("isDiscordDmSenderAllowed", () => {
  test("open and unset policies admit any sender", () => {
    expect(isDiscordDmSenderAllowed({}, STRANGER)).toBe(true);
    expect(isDiscordDmSenderAllowed({ dmPolicy: "open" }, STRANGER)).toBe(true);
  });

  test("disabled admits nobody, including owners", () => {
    const metadata = {
      dmPolicy: "disabled" as const,
      ownerDiscordUserId: OWNER,
    };
    expect(isDiscordDmSenderAllowed(metadata, OWNER)).toBe(false);
    expect(isDiscordDmSenderAllowed(metadata, STRANGER)).toBe(false);
  });

  test("allowlist admits owners and explicit entries only", () => {
    const metadata = {
      dmPolicy: "allowlist" as const,
      ownerDiscordUserId: OWNER,
      ownerDiscordUserIds: [CO_OWNER],
      dmAllowFrom: [FRIEND],
    };
    expect(isDiscordDmSenderAllowed(metadata, OWNER)).toBe(true);
    expect(isDiscordDmSenderAllowed(metadata, CO_OWNER)).toBe(true);
    expect(isDiscordDmSenderAllowed(metadata, FRIEND)).toBe(true);
    expect(isDiscordDmSenderAllowed(metadata, STRANGER)).toBe(false);
  });

  test("pairing admits owners but ignores allowlist entries", () => {
    const metadata = {
      dmPolicy: "pairing" as const,
      ownerDiscordUserId: OWNER,
      dmAllowFrom: [FRIEND],
    };
    expect(isDiscordDmSenderAllowed(metadata, OWNER)).toBe(true);
    expect(isDiscordDmSenderAllowed(metadata, FRIEND)).toBe(false);
  });
});
