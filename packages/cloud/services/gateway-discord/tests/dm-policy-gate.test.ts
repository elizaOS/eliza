/** Tests standalone assignment-state validation and the mirrored DM policy matrix. */
import { describe, expect, test } from "bun:test";
import {
  type DiscordConnectionDmPolicyState,
  isDmSenderAllowed,
  parseDiscordConnectionDmPolicyState,
} from "../src/dm-policy";

const OWNER = "111111111111111111";
const CO_OWNER = "222222222222222222";
const FRIEND = "333333333333333333";
const STRANGER = "999999999999999999";

function valid(
  metadata: Extract<
    DiscordConnectionDmPolicyState,
    { status: "valid" }
  >["metadata"],
): DiscordConnectionDmPolicyState {
  return { status: "valid", metadata };
}

describe("isDmSenderAllowed", () => {
  test("valid unset and open policies admit everyone", () => {
    expect(isDmSenderAllowed(valid({}), STRANGER)).toBe(true);
    expect(isDmSenderAllowed(valid({ dmPolicy: "open" }), STRANGER)).toBe(true);
  });

  test("disabled admits nobody, including owners", () => {
    const state = valid({
      dmPolicy: "disabled",
      ownerDiscordUserId: OWNER,
    });
    expect(isDmSenderAllowed(state, OWNER)).toBe(false);
    expect(isDmSenderAllowed(state, STRANGER)).toBe(false);
  });

  test("allowlist admits owners and configured senders only", () => {
    const state = valid({
      dmPolicy: "allowlist",
      ownerDiscordUserId: OWNER,
      ownerDiscordUserIds: [CO_OWNER],
      dmAllowFrom: [FRIEND],
    });
    expect(isDmSenderAllowed(state, OWNER)).toBe(true);
    expect(isDmSenderAllowed(state, CO_OWNER)).toBe(true);
    expect(isDmSenderAllowed(state, FRIEND)).toBe(true);
    expect(isDmSenderAllowed(state, STRANGER)).toBe(false);
  });

  test("pairing admits owners but ignores dmAllowFrom", () => {
    const state = valid({
      dmPolicy: "pairing",
      ownerDiscordUserId: OWNER,
      dmAllowFrom: [FRIEND],
    });
    expect(isDmSenderAllowed(state, OWNER)).toBe(true);
    expect(isDmSenderAllowed(state, FRIEND)).toBe(false);
  });

  test("missing or invalid assignment state fails closed", () => {
    expect(isDmSenderAllowed(undefined, OWNER)).toBe(false);
    expect(isDmSenderAllowed({ status: "invalid" }, OWNER)).toBe(false);
  });
});

describe("parseDiscordConnectionDmPolicyState", () => {
  test("accepts the producer envelope and strips unrelated fields", () => {
    expect(
      parseDiscordConnectionDmPolicyState({
        status: "valid",
        metadata: {
          dmPolicy: "disabled",
          responseMode: "keyword",
        },
      }),
    ).toEqual({ status: "valid", metadata: { dmPolicy: "disabled" } });
  });

  test("rejects missing, malformed, and invalid restrictive envelopes", () => {
    for (const value of [
      undefined,
      null,
      {},
      { status: "valid", metadata: { dmPolicy: "allowlist", dmAllowFrom: ["bad"] } },
      { status: "valid", metadata: { dmPolicy: "unknown" } },
      { status: "invalid" },
    ]) {
      expect(parseDiscordConnectionDmPolicyState(value)).toEqual({
        status: "invalid",
      });
    }
  });
});
