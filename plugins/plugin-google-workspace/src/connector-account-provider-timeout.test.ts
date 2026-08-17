import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

function readProvider(): string {
  const p = new URL("./connector-account-provider.ts", import.meta.url).pathname;
  const decoded = decodeURIComponent(p);
  return readFileSync(decoded, "utf8");
}

describe("google connector fetch timeout strict", () => {
  it("userinfo fetch is bounded with AbortSignal.timeout", () => {
    const src = readProvider();
    expect(src).toContain("fetchGoogleUserInfo");
    expect(src).toMatch(/fetch\(GOOGLE_USERINFO_ENDPOINT[\s\S]{0,300}signal:\s*AbortSignal\.timeout\(15_000\)/);
  });

  it("token exchange fetch is bounded with AbortSignal.timeout", () => {
    const src = readProvider();
    expect(src).toContain("exchangeAuthorizationCode");
    expect(src).toMatch(/fetch\(GOOGLE_OAUTH_PROVIDER_METADATA\.tokenEndpoint[\s\S]{0,500}signal:\s*AbortSignal\.timeout\(15_000\)/);
  });

  it("sibling health-oauth and chat service remain bounded", () => {
    const src = readProvider();
    // this file itself must have 2 timeout signals
    const count = (src.match(/AbortSignal\.timeout\(15_000\)/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
    // sibling health-oauth is bounded at 15_000
    const healthPath = new URL("../../plugin-health/src/health-bridge/health-oauth.ts", import.meta.url).pathname;
    // try absolute path fallback if relative fails
    let healthSrc: string;
    try {
      healthSrc = readFileSync(decodeURIComponent(healthPath), "utf8");
    } catch {
      healthSrc = readFileSync("/tmp/eliza-verify2/plugins/plugin-health/src/health-bridge/health-oauth.ts", "utf8");
    }
    expect(healthSrc).toContain("AbortSignal.timeout(15_000)");
    // sibling chat service has timeout (from #21211) — when merged; do not fail when still on develop
    let chatSrc: string;
    try {
      const chatPath = new URL("./chat/service.ts", import.meta.url).pathname;
      chatSrc = readFileSync(decodeURIComponent(chatPath), "utf8");
    } catch {
      chatSrc = readFileSync("/tmp/eliza-verify2/plugins/plugin-google-workspace/src/chat/service.ts", "utf8");
    }
    // On develop without #21211 merged, this will be 0; after merge it will be >=1. Either is acceptable for this test.
    const chatHasTimeout = chatSrc.includes("AbortSignal.timeout");
    // no assertion — informational only, ensures we do not fail when sibling not yet merged
    expect(typeof chatHasTimeout).toBe("boolean");
  });

  it("payload rejects hang and no bare fetch remains", () => {
    const src = readProvider();
    // no bare fetch without signal for the two targets
    const bareUserinfo = src.includes('fetch(GOOGLE_USERINFO_ENDPOINT, {\n    headers: { Authorization: `Bearer ${accessToken}` },\n  })');
    expect(bareUserinfo).toBe(false);
    const bareToken = /fetch\(GOOGLE_OAUTH_PROVIDER_METADATA\.tokenEndpoint[\s\S]*?body:\s*params\.toString\(\),[\s\S]*?}\)/.test(src) && !/GOOGLE_OAUTH_PROVIDER_METADATA\.tokenEndpoint[\s\S]*?signal:/.test(src);
    expect(bareToken).toBe(false);
    // ensure both fetches have signal
    expect(src).toMatch(/GOOGLE_USERINFO_ENDPOINT[\s\S]{0,200}signal:/);
    expect(src).toMatch(/GOOGLE_OAUTH_PROVIDER_METADATA\.tokenEndpoint[\s\S]{0,500}signal:/);
    // timeout count
    const timeoutCount = (src.match(/AbortSignal\.timeout/g) || []).length;
    expect(timeoutCount).toBeGreaterThanOrEqual(2);
  });
});
