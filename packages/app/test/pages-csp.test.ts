/**
 * Unit tests for the Pages Csp app shell contract and coverage guardrail.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const headersPath = join(import.meta.dirname, "..", "public", "_headers");
const headers = readFileSync(headersPath, "utf8");
const indexPath = join(import.meta.dirname, "..", "index.html");
const indexHtml = readFileSync(indexPath, "utf8");

function getHeaderLine(name: string): string {
  const line = headers
    .split(/\r?\n/)
    .find((candidate) => candidate.trimStart().startsWith(`${name}:`));
  if (!line) throw new Error(`missing ${name} header`);
  return line.trimStart();
}

function getMetaCsp(): string {
  const match = indexHtml.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([\s\S]*?)"\s*\/>/iu,
  );
  if (!match?.[1]) throw new Error("missing index.html CSP meta policy");
  return match[1].replaceAll(/\s+/gu, " ");
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

  it("allows the official Telegram script origin and OAuth frame host", () => {
    const csp = getHeaderLine("Content-Security-Policy");
    const scriptSrc = csp.match(/script-src ([^;]+);/)?.[1];
    const frameSrc = csp.match(/frame-src ([^;]+);/)?.[1];

    expect(scriptSrc).toContain("https://telegram.org");
    expect(scriptSrc).not.toContain("https://*.telegram.org");
    expect(frameSrc).toContain("https://oauth.telegram.org");
  });

  it("allows authenticated remote views to execute from temporary module URLs", () => {
    const edgeCsp = getHeaderLine("Content-Security-Policy");
    const metaCsp = getMetaCsp();
    const edgeScriptSrc = edgeCsp.match(/script-src ([^;]+);/)?.[1];
    const metaScriptSrc = metaCsp.match(/script-src ([^;]+);/)?.[1];

    expect(edgeScriptSrc?.split(/\s+/)).toContain("blob:");
    expect(metaScriptSrc?.split(/\s+/)).toContain("blob:");
  });
});
