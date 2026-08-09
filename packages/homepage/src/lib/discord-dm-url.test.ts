import { describe, expect, it } from "vitest";
import { buildDiscordDmUrl } from "./discord-dm-url";

describe("buildDiscordDmUrl", () => {
  it("builds the bot profile URL used to open a Discord DM", () => {
    expect(buildDiscordDmUrl("1474591626759376967")).toBe(
      "https://discord.com/users/1474591626759376967",
    );
  });

  it("rejects missing or malformed application ids", () => {
    expect(buildDiscordDmUrl()).toBeNull();
    expect(buildDiscordDmUrl("not-an-id")).toBeNull();
    expect(buildDiscordDmUrl("1474591626759376967/path")).toBeNull();
  });
});
