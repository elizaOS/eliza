/**
 * Policy matrix for the gateway-local DM gate (#19912 P1 repair): the gate
 * runs BEFORE the in-worker vs dedicated route choice in gateway-manager, so
 * these semantics now hold for BOTH topologies. Mirrors (and must stay in
 * lockstep with) the Cloud shared event-router gate's suite.
 */
import { describe, expect, test } from "bun:test";
import { isDmSenderAllowed } from "../src/dm-policy";

const OWNER = "111";
const CO_OWNER = "222";
const FRIEND = "333";
const STRANGER = "999";

describe("isDmSenderAllowed — policy matrix", () => {
  test("unset and open admit everyone (historical behavior)", () => {
    expect(isDmSenderAllowed({}, STRANGER)).toBe(true);
    expect(isDmSenderAllowed({ dmPolicy: "open" }, STRANGER)).toBe(true);
    expect(isDmSenderAllowed({ dmPolicy: null }, STRANGER)).toBe(true);
  });

  test("disabled admits nobody, including owners", () => {
    const metadata = {
      dmPolicy: "disabled" as const,
      ownerDiscordUserId: OWNER,
    };
    expect(isDmSenderAllowed(metadata, OWNER)).toBe(false);
    expect(isDmSenderAllowed(metadata, STRANGER)).toBe(false);
  });

  test("allowlist admits owners (both fields) plus dmAllowFrom, nobody else", () => {
    const metadata = {
      dmPolicy: "allowlist" as const,
      ownerDiscordUserId: OWNER,
      ownerDiscordUserIds: [CO_OWNER],
      dmAllowFrom: [FRIEND],
    };
    expect(isDmSenderAllowed(metadata, OWNER)).toBe(true);
    expect(isDmSenderAllowed(metadata, CO_OWNER)).toBe(true);
    expect(isDmSenderAllowed(metadata, FRIEND)).toBe(true);
    expect(isDmSenderAllowed(metadata, STRANGER)).toBe(false);
  });

  test("pairing admits owners only — dmAllowFrom does NOT apply", () => {
    const metadata = {
      dmPolicy: "pairing" as const,
      ownerDiscordUserId: OWNER,
      ownerDiscordUserIds: [CO_OWNER],
      dmAllowFrom: [FRIEND],
    };
    expect(isDmSenderAllowed(metadata, OWNER)).toBe(true);
    expect(isDmSenderAllowed(metadata, CO_OWNER)).toBe(true);
    expect(isDmSenderAllowed(metadata, FRIEND)).toBe(false);
    expect(isDmSenderAllowed(metadata, STRANGER)).toBe(false);
  });

  test("restrictive policies with empty owner sets fail closed", () => {
    expect(isDmSenderAllowed({ dmPolicy: "allowlist" }, STRANGER)).toBe(false);
    expect(isDmSenderAllowed({ dmPolicy: "pairing" }, STRANGER)).toBe(false);
  });
});
