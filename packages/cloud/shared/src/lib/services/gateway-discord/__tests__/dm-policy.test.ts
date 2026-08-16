/**
 * Unit tests for the gateway Discord DM-policy gate and the connection
 * metadata schema fields it depends on. Deterministic, no mocks: exercises
 * the real isDmSenderAllowed function and the real Zod metadata schema.
 */

import { describe, expect, test } from "bun:test";
import {
  DiscordConnectionMetadataSchema,
  parseDiscordConnectionDmPolicyState,
} from "../../../../db/schemas/discord-connections";
import { isDmSenderAllowed } from "../dm-policy";

const OWNER = "123456789012345678";
const FRIEND = "234567890123456789";
const STRANGER = "345678901234567890";

describe("isDmSenderAllowed", () => {
  test("unset policy preserves historical open behavior", () => {
    expect(isDmSenderAllowed({}, STRANGER)).toBe(true);
  });

  test("open admits anyone", () => {
    expect(isDmSenderAllowed({ dmPolicy: "open" }, STRANGER)).toBe(true);
  });

  test("disabled admits nobody, including the owner", () => {
    const metadata = { dmPolicy: "disabled" as const, ownerDiscordUserId: OWNER };
    expect(isDmSenderAllowed(metadata, OWNER)).toBe(false);
    expect(isDmSenderAllowed(metadata, STRANGER)).toBe(false);
  });

  test("pairing admits owners only", () => {
    const metadata = {
      dmPolicy: "pairing" as const,
      ownerDiscordUserId: OWNER,
      dmAllowFrom: [FRIEND],
    };
    expect(isDmSenderAllowed(metadata, OWNER)).toBe(true);
    // dmAllowFrom does not apply outside the allowlist policy
    expect(isDmSenderAllowed(metadata, FRIEND)).toBe(false);
    expect(isDmSenderAllowed(metadata, STRANGER)).toBe(false);
  });

  test("pairing honors the ownerDiscordUserIds array", () => {
    const metadata = {
      dmPolicy: "pairing" as const,
      ownerDiscordUserIds: [OWNER, FRIEND],
    };
    expect(isDmSenderAllowed(metadata, OWNER)).toBe(true);
    expect(isDmSenderAllowed(metadata, FRIEND)).toBe(true);
    expect(isDmSenderAllowed(metadata, STRANGER)).toBe(false);
  });

  test("allowlist admits owner plus dmAllowFrom and rejects strangers", () => {
    const metadata = {
      dmPolicy: "allowlist" as const,
      ownerDiscordUserId: OWNER,
      dmAllowFrom: [FRIEND],
    };
    expect(isDmSenderAllowed(metadata, OWNER)).toBe(true);
    expect(isDmSenderAllowed(metadata, FRIEND)).toBe(true);
    expect(isDmSenderAllowed(metadata, STRANGER)).toBe(false);
  });

  test("allowlist with no owner and no entries fails closed", () => {
    expect(isDmSenderAllowed({ dmPolicy: "allowlist" }, STRANGER)).toBe(false);
  });
});

describe("DiscordConnectionMetadataSchema DM fields", () => {
  test("accepts valid dmPolicy values", () => {
    for (const dmPolicy of ["open", "allowlist", "pairing", "disabled"] as const) {
      const result = DiscordConnectionMetadataSchema.safeParse({ dmPolicy });
      expect(result.success).toBe(true);
    }
  });

  test("rejects unknown dmPolicy values", () => {
    const result = DiscordConnectionMetadataSchema.safeParse({ dmPolicy: "everyone" });
    expect(result.success).toBe(false);
  });

  test("accepts snowflake arrays for dmAllowFrom and ownerDiscordUserIds", () => {
    const result = DiscordConnectionMetadataSchema.safeParse({
      dmPolicy: "allowlist",
      dmAllowFrom: [FRIEND, STRANGER],
      ownerDiscordUserIds: [OWNER],
    });
    expect(result.success).toBe(true);
  });

  test("rejects non-snowflake dmAllowFrom entries", () => {
    for (const bad of ["not-a-snowflake", "123", "12345678901234567890123", ""]) {
      const result = DiscordConnectionMetadataSchema.safeParse({
        dmPolicy: "allowlist",
        dmAllowFrom: [bad],
      });
      expect(result.success).toBe(false);
    }
  });

  test("rejects non-snowflake ownerDiscordUserIds entries", () => {
    const result = DiscordConnectionMetadataSchema.safeParse({
      ownerDiscordUserIds: ["abc"],
    });
    expect(result.success).toBe(false);
  });
});
describe("parseDiscordConnectionDmPolicyState", () => {
  test("enforces restrictive DM fields independently of invalid keyword metadata", () => {
    expect(
      parseDiscordConnectionDmPolicyState({
        responseMode: "keyword",
        dmPolicy: "disabled",
      }),
    ).toEqual({
      status: "valid",
      metadata: { dmPolicy: "disabled" },
    });
    expect(
      parseDiscordConnectionDmPolicyState({
        responseMode: "keyword",
        dmPolicy: "allowlist",
        dmAllowFrom: [FRIEND],
      }),
    ).toEqual({
      status: "valid",
      metadata: { dmPolicy: "allowlist", dmAllowFrom: [FRIEND] },
    });
  });

  test("treats absent metadata as open and malformed DM fields as invalid", () => {
    expect(parseDiscordConnectionDmPolicyState(null)).toEqual({
      status: "valid",
      metadata: {},
    });
    for (const value of [
      { dmPolicy: "unknown" },
      { dmPolicy: "disabled", ownerDiscordUserId: "bad" },
      { dmPolicy: "allowlist", dmAllowFrom: ["bad"] },
      "not-an-object",
    ]) {
      expect(parseDiscordConnectionDmPolicyState(value)).toEqual({
        status: "invalid",
      });
    }
  });
});
