/**
 * Coverage for discord-api.
 */
import { describe, expect, it } from "vitest";
import {
  DISCORD_API_BASE,
  discordBearerAuthHeader,
  discordBearerHeaders,
  discordBotAuthHeader,
  discordBotHeaders,
} from "./discord-api.js";

describe("discord-api", () => {
  it("exposes base", () => {
    expect(DISCORD_API_BASE).toBe("https://discord.com/api/v10");
  });
  it("builds bot header", () => {
    expect(discordBotAuthHeader("tok123")).toBe("Bot tok123");
  });
  it("builds bearer header", () => {
    expect(discordBearerAuthHeader("tok123")).toBe("Bearer tok123");
  });
  it("builds bot headers", () => {
    const h = discordBotHeaders("tok", { "X-Custom": "v" }) as Record<string, string>;
    expect(h.Authorization).toBe("Bot tok");
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["X-Custom"]).toBe("v");
  });
  it("builds bearer headers", () => {
    const h = discordBearerHeaders("tok") as Record<string, string>;
    expect(h.Authorization).toBe("Bearer tok");
  });
});
