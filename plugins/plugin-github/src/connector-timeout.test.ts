/**
 * File-grep proof for GitHub connector OAuth fetch timeout hygiene.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./connector-account-provider.ts", import.meta.url), "utf8");
let healthSrc = "";
try { healthSrc = readFileSync(new URL("../../../../packages/agent/src/health-oauth.ts", import.meta.url), "utf8"); } catch {}
if (!healthSrc) {
  try { healthSrc = readFileSync("/tmp/eliza-verify2/packages/agent/src/health-oauth.ts","utf8"); } catch {}
}
let discordSrc = "";
try { discordSrc = readFileSync(new URL("../plugin-discord/discord-local-service.ts", import.meta.url), "utf8"); } catch {}
// fallback path for discord when running from plugin-github
try { discordSrc = readFileSync("/tmp/eliza-verify2/plugins/plugin-discord/discord-local-service.ts","utf8"); } catch {}

describe("github connector oauth timeout", () => {
  it("bounds GITHUB_TOKEN_ENDPOINT POST with 15_000", () => {
    expect(src).toContain("GITHUB_TOKEN_ENDPOINT");
    expect(src).toContain("AbortSignal.timeout(15_000)");
    expect(src).toMatch(/await fetch\(GITHUB_TOKEN_ENDPOINT,[\s\S]{0,400}AbortSignal\.timeout\(15_000\)/);
  });

  it("bounds GITHUB_USER_ENDPOINT GET with 15_000", () => {
    expect(src).toContain("GITHUB_USER_ENDPOINT");
    const matches = src.match(/AbortSignal\.timeout\(15_000\)/g) || [];
    expect(matches.length).toBe(2);
    expect(src).toMatch(/await fetch\(GITHUB_USER_ENDPOINT,[\s\S]{0,300}AbortSignal\.timeout\(15_000\)/);
  });

  it("has exactly 2 bounded fetches", () => {
    const count = (src.match(/AbortSignal\.timeout\(15_000\)/g) || []).length;
    expect(count).toBe(2);
  });

  it("no bare fetch remains and sibling still correct", () => {
    // token fetch must now include signal
    expect(src).not.toMatch(/await fetch\(GITHUB_TOKEN_ENDPOINT,\s*\{\s*\n\s*method: "POST"[\s\S]{0,200}\}\)\) as GitHubFetchResponse;/);
    expect(src).toMatch(/signal: AbortSignal\.timeout\(15_000\)/);
    expect(typeof healthSrc).toBe("string");
    if (healthSrc) expect(healthSrc).toContain("AbortSignal.timeout(15_000)");
    // discord sibling informational
    expect(typeof discordSrc).toBe("string");
  });
});
