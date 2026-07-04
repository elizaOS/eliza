/**
 * Unit tests for the Pages Csp app shell contract and coverage guardrail.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const headersPath = join(import.meta.dirname, "..", "public", "_headers");
const headers = readFileSync(headersPath, "utf8");

function getHeaderLine(name: string): string {
  const line = headers
    .split(/\r?\n/)
    .find((candidate) => candidate.trimStart().startsWith(`${name}:`));
  if (!line) throw new Error(`missing ${name} header`);
  return line.trimStart();
}

describe("Pages CSP", () => {
  it("keeps the global CSP below the Cloudflare Pages header limit", () => {
    const csp = getHeaderLine("Content-Security-Policy");

    expect(csp.length).toBeLessThan(1900);
  });

  it("allows weather fetches without enabling browser IP geolocation calls", () => {
    const csp = getHeaderLine("Content-Security-Policy");

    expect(csp).toContain("connect-src");
    expect(csp).toContain("https://api.open-meteo.com");
    expect(csp).not.toContain("https://ipapi.co");
  });
});
