/** Tests canonical account-owner authorization without a database harness. */
import { describe, expect, test } from "bun:test";
import { evaluateManagedDiscordGuildVoiceOwner } from "./managed-discord-guild-voice-policy";

describe("evaluateManagedDiscordGuildVoiceOwner", () => {
  test("denies an unlinked Discord identity", () => {
    expect(evaluateManagedDiscordGuildVoiceOwner(undefined)).toEqual({
      allowed: false,
      reason: "identity_not_linked",
    });
  });

  test("denies a linked non-owner and a cross-organization projection", () => {
    expect(
      evaluateManagedDiscordGuildVoiceOwner({
        id: "user-1",
        role: "member",
        organization_id: "org-1",
        organization: { id: "org-1" },
      }),
    ).toEqual({ allowed: false, reason: "not_owner" });
    expect(
      evaluateManagedDiscordGuildVoiceOwner({
        id: "user-1",
        role: "owner",
        organization_id: "org-2",
        organization: { id: "org-1" },
      }),
    ).toEqual({ allowed: false, reason: "not_owner" });
  });

  test("accepts only the canonical owner in the linked organization", () => {
    expect(
      evaluateManagedDiscordGuildVoiceOwner({
        id: "user-1",
        role: "owner",
        organization_id: "org-1",
        organization: { id: "org-1" },
      }),
    ).toEqual({ allowed: true, userId: "user-1", organizationId: "org-1" });
  });
});
