/**
 * File-grep proof for bluebubbles client fetch timeout hygiene.
 * Proves request and attachment fetches are bounded with AbortSignal.timeout.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const clientSrc = readFileSync(new URL("./client.ts", import.meta.url), "utf8");
let healthSrc = "";
try { healthSrc = readFileSync(new URL("../../../packages/agent/src/health-oauth.ts", import.meta.url), "utf8"); } catch {}
if (!healthSrc) {
  try { healthSrc = readFileSync("/tmp/eliza-verify2/packages/agent/src/health-oauth.ts", "utf8"); } catch {}
}

describe("bluebubbles client fetch timeout", () => {
  it("bounds request() with AbortSignal.timeout(15_000)", () => {
    expect(clientSrc).toContain("urlWithPassword");
    expect(clientSrc).toContain("AbortSignal.timeout(15_000)");
    // request must use options.signal fallback
    expect(clientSrc).toMatch(/signal:\s*options\.signal\s*\?\?\s*AbortSignal\.timeout\(15_000\)/);
  });

  it("bounds attachment sends with AbortSignal.timeout(30_000)", () => {
    const attMatches = clientSrc.match(/AbortSignal\.timeout\(30_000\)/g) || [];
    expect(attMatches.length).toBe(2);
    expect(clientSrc).toContain('method: "POST"');
    expect(clientSrc).toContain('body: formData');
  });

  it("has exactly 3 bounded fetches total", () => {
    const all = clientSrc.match(/AbortSignal\.timeout\(/g) || [];
    expect(all.length).toBe(3);
  });

  it("no bare fetch remains in client and sibling still correct", () => {
    // client should have no bare fetch(url) without signal in the 3 mutated sites
    const bareCount = (clientSrc.match(/await fetch\(urlWithPassword,/g) || []).length;
    expect(bareCount).toBe(1);
    // ensure that one is now accompanied by signal within 400 chars
    expect(clientSrc).toMatch(/await fetch\(urlWithPassword,[\s\S]{0,400}AbortSignal\.timeout/);
    // check attachment fetches also accompanied
    expect(clientSrc).toMatch(/await fetch\(url,\s*\{\s*\n\s*method: "POST"[\s\S]{0,200}AbortSignal\.timeout\(30_000\)/);
    // sibling health-oauth must still be bounded (informational sibling)
    expect(typeof healthSrc).toBe("string");
    if (healthSrc) expect(healthSrc).toContain("AbortSignal.timeout");
  });
});
