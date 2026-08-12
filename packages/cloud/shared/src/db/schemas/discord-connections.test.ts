/** Verifies the validated metadata persisted for Discord Gateway connections. */

import { describe, expect, test } from "bun:test";
import { DiscordConnectionMetadataSchema } from "./discord-connections";

describe("DiscordConnectionMetadataSchema ownership controls", () => {
  test("preserves owner user IDs, DM policy, and the DM allowlist", () => {
    const metadata = {
      responseMode: "mention" as const,
      ownerDiscordUserId: "123456789012345678",
      dmPolicy: "allowlist" as const,
      allowFrom: ["234567890123456789"],
    };

    expect(DiscordConnectionMetadataSchema.parse(metadata)).toEqual(metadata);
  });

  test("rejects unsupported DM policies", () => {
    const result = DiscordConnectionMetadataSchema.safeParse({
      dmPolicy: "friends-only",
    });

    expect(result.success).toBe(false);
  });
});
