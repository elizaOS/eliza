/**
 * buildTelegramWorldOwnership: pure decision table for who may own a Telegram
 * world. Guards the fail-open regression where the arbitrary DM sender became
 * `ownership.ownerId` (and therefore OWNER) whenever no canonical owner was
 * configured.
 */
import { Role } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { buildTelegramWorldOwnership } from "./world-ownership";

const CANONICAL = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CREATOR = "cccccccc-cccc-cccc-cccc-cccccccccccc";

describe("buildTelegramWorldOwnership", () => {
  it("grants the configured canonical owner when present", () => {
    expect(buildTelegramWorldOwnership(CANONICAL, null)).toEqual({
      ownership: { ownerId: CANONICAL },
      roles: { [CANONICAL]: Role.OWNER },
    });
  });

  it("prefers the canonical owner over the chat creator", () => {
    expect(buildTelegramWorldOwnership(CANONICAL, CREATOR)).toEqual({
      ownership: { ownerId: CANONICAL },
      roles: { [CANONICAL]: Role.OWNER },
    });
  });

  it("falls back to the chat creator only (group chats)", () => {
    expect(buildTelegramWorldOwnership(null, CREATOR)).toEqual({
      ownership: { ownerId: CREATOR },
      roles: { [CREATOR]: Role.OWNER },
    });
  });

  it("records NO ownership when neither identity exists (DM from a stranger)", () => {
    // The regression this guards: `canonicalOwnerId ?? senderId` made every DM
    // sender OWNER of their own DM world in unconfigured deployments.
    expect(buildTelegramWorldOwnership(null, null)).toEqual({ roles: {} });
    expect(buildTelegramWorldOwnership(undefined, undefined)).toEqual({
      roles: {},
    });
  });
});
