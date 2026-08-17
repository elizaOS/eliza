import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

function readDiscord(): string {
  const file = new URL("./discord-local-service.ts", import.meta.url).pathname;
  return readFileSync(decodeURIComponent(file), "utf8");
}

describe("discord oauth fetch timeout strict", () => {
  it("token exchange is bounded with AbortSignal.timeout", () => {
    const src = readDiscord();
    expect(src).toMatch(/exchange[\s\S]{0,500}fetch\(DISCORD_OAUTH_TOKEN_URL,[\s\S]{0,300}signal:\s*AbortSignal\.timeout\(15_000\)/);
  });

  it("refresh token is bounded with AbortSignal.timeout", () => {
    const src = readDiscord();
    expect(src).toMatch(/refreshAccessToken[\s\S]{0,500}fetch\(DISCORD_OAUTH_TOKEN_URL,[\s\S]{0,300}signal:\s*AbortSignal\.timeout\(15_000\)/);
  });

  it("no bare DISCORD_OAUTH_TOKEN_URL fetch remains", () => {
    const src = readDiscord();
    expect(src).not.toContain('fetch(DISCORD_OAUTH_TOKEN_URL, {\n\t\t\tmethod: "POST",\n\t\t\theaders: {\n\t\t\t\t"Content-Type": "application/x-www-form-urlencoded",\n\t\t\t},\n\t\t\tbody,\n\t\t});');
    const count = (src.match(/AbortSignal\.timeout\(15_000\)/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("sibling health oauth still bounded", () => {
    const src = readDiscord();
    expect(src).toContain("AbortSignal.timeout(15_000)");
    let healthHas = false;
    try {
      const health = readFileSync("/tmp/eliza-verify2/plugins/plugin-health/src/health-bridge/health-oauth.ts", "utf8");
      healthHas = health.includes("AbortSignal.timeout(15_000)");
    } catch {}
    expect(healthHas).toBe(true);
  });
});
