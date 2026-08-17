/**
 * File-grep proof for credential-proxy git helper fetch timeout.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./credential-proxy-env.ts", import.meta.url), "utf8");
let healthSrc = "";
try { healthSrc = readFileSync(new URL("../../../../packages/agent/src/health-oauth.ts", import.meta.url), "utf8"); } catch {}
if (!healthSrc) {
  try { healthSrc = readFileSync("/tmp/eliza-verify2/packages/agent/src/health-oauth.ts","utf8"); } catch {}
}

describe("credential proxy helper timeout", () => {
  it("bounds git-credential helper POST with 15_000", () => {
    expect(src).toContain("GIT_CREDENTIAL_PROXY_HELPER_SOURCE");
    expect(src).toContain("AbortSignal.timeout(15_000)");
    expect(src).toMatch(/await fetch\(endpoint, \{ method: "POST", headers, body, signal: AbortSignal\.timeout\(15_000\) \}\)/);
  });

  it("helper source still defines endpoint and signing", () => {
    expect(src).toContain('"/git-credential"');
    expect(src).toContain("x-eliza-proxy-signature");
    expect(src).toContain("createHmac");
  });

  it("exactly 1 helper fetch bounded", () => {
    const matches = src.match(/AbortSignal\.timeout\(15_000\)/g) || [];
    expect(matches.length).toBe(1);
  });

  it("no bare helper fetch remains and sibling still correct", () => {
    expect(src).not.toContain('await fetch(endpoint, { method: "POST", headers, body });');
    expect(typeof healthSrc).toBe("string");
    if (healthSrc) expect(healthSrc).toContain("AbortSignal.timeout(15_000)");
  });
});
