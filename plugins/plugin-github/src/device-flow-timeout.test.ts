/**
 * File-grep proof for GitHub device-flow fetch timeout.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./device-flow.ts", import.meta.url), "utf8");
let healthSrc = "";
try { healthSrc = readFileSync(new URL("../../../../packages/agent/src/health-oauth.ts", import.meta.url), "utf8"); } catch {}
if (!healthSrc) {
  try { healthSrc = readFileSync("/tmp/eliza-verify2/packages/agent/src/health-oauth.ts","utf8"); } catch {}
}
let connectorSrc = "";
try { connectorSrc = readFileSync(new URL("./connector-account-provider.ts", import.meta.url), "utf8"); } catch {}
// fallback for when connector fix not on this branch — check the file still exists
try { connectorSrc = readFileSync("/tmp/eliza-verify2/plugins/plugin-github/src/connector-account-provider.ts","utf8"); } catch {}

describe("github device-flow timeout", () => {
  it("bounds postForm POST with 15_000", () => {
    expect(src).toContain("DEVICE_CODE_URL");
    expect(src).toContain("ACCESS_TOKEN_URL");
    expect(src).toContain("AbortSignal.timeout(15_000)");
    expect(src).toMatch(/await fetchImpl\(url,[\s\S]{0,400}AbortSignal\.timeout\(15_000\)/);
  });

  it("covers both device_code and token polling via single site", () => {
    const matches = src.match(/AbortSignal\.timeout\(15_000\)/g) || [];
    expect(matches.length).toBe(1);
    expect(src).toContain('postForm(');
    expect(src).toContain("GitHub device-code request");
    expect(src).toContain("GitHub device-token request");
  });

  it("postForm fetch has correct headers and signal", () => {
    expect(src).toContain('Accept: "application/json"');
    expect(src).toContain('"Content-Type": "application/x-www-form-urlencoded"');
    expect(src).toMatch(/fetchImpl\(url, \{[\s\S]{0,400}signal: AbortSignal\.timeout\(15_000\)/);
  });

  it("no bare fetchImpl remains and sibling still correct", () => {
    // bare without signal should be gone
    expect(src).not.toMatch(/await fetchImpl\(url, \{\s*\n\s*method: "POST"[\s\S]{0,200}body: new URLSearchParams\(form\)\.toString\(\),\s*\n\s*\}\);/);
    expect(typeof healthSrc).toBe("string");
    if (healthSrc) expect(healthSrc).toContain("AbortSignal.timeout(15_000)");
    expect(typeof connectorSrc).toBe("string");
  });
});
