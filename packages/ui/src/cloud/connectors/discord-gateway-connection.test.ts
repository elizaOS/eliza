/**
 * Verifies Discord connection edits preserve access-control metadata that the
 * Cloud form does not expose while still allowing editable DM fields to clear.
 */

import { describe, expect, it } from "vitest";
import { buildDiscordConnectionMetadataUpdate } from "./discord-connection-metadata";

describe("buildDiscordConnectionMetadataUpdate", () => {
  it("preserves keyword, channel, and plural-owner restrictions", () => {
    const stored = {
      responseMode: "keyword" as const,
      keywords: ["help", "support"],
      enabledChannels: ["channel-allow"],
      disabledChannels: ["channel-deny"],
      ownerDiscordUserId: "111111111111111",
      ownerDiscordUserIds: ["222222222222222", "333333333333333"],
      dmPolicy: "pairing" as const,
      dmAllowFrom: ["444444444444444"],
    };

    const result = buildDiscordConnectionMetadataUpdate(stored, {
      responseMode: "keyword",
      ownerDiscordUserId: " 555555555555555 ",
      dmPolicy: "allowlist",
      dmAllowFrom: ["666666666666666"],
    });

    expect(result).toEqual({
      responseMode: "keyword",
      keywords: ["help", "support"],
      enabledChannels: ["channel-allow"],
      disabledChannels: ["channel-deny"],
      ownerDiscordUserId: "555555555555555",
      ownerDiscordUserIds: ["222222222222222", "333333333333333"],
      dmPolicy: "allowlist",
      dmAllowFrom: ["666666666666666"],
    });
    expect(stored).toEqual({
      responseMode: "keyword",
      keywords: ["help", "support"],
      enabledChannels: ["channel-allow"],
      disabledChannels: ["channel-deny"],
      ownerDiscordUserId: "111111111111111",
      ownerDiscordUserIds: ["222222222222222", "333333333333333"],
      dmPolicy: "pairing",
      dmAllowFrom: ["444444444444444"],
    });
  });

  it("clears open and empty DM controls without dropping unrelated metadata", () => {
    expect(
      buildDiscordConnectionMetadataUpdate(
        {
          responseMode: "mention",
          enabledChannels: ["channel-allow"],
          ownerDiscordUserId: "111111111111111",
          dmPolicy: "disabled",
          dmAllowFrom: ["222222222222222"],
        },
        {
          responseMode: "always",
          ownerDiscordUserId: "",
          dmPolicy: "open",
          dmAllowFrom: [],
        },
      ),
    ).toEqual({
      responseMode: "always",
      enabledChannels: ["channel-allow"],
    });
  });
});
