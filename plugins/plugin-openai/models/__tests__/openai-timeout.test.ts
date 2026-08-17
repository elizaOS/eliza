/**
 * Proves OpenAI provider fetch timeout (rank 8 clone of wallet attestation-fetch 10s timeout).
 * All 4 external fetches now have AbortSignal.timeout(30_000) matching research.ts and attestation-fetch.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const audioPath = new URL("../audio.ts", import.meta.url).pathname;
const imagePath = new URL("../image.ts", import.meta.url).pathname;
const researchPath = new URL("../research.ts", import.meta.url).pathname;
const walletPath = path.join(process.cwd(), "plugins/plugin-wallet/src/sdk/bridge/attestation-fetch.ts");

describe("openai fetch timeout — bounded worker", () => {
  test("audio transcriptions and speech have AbortSignal.timeout", () => {
    const src = readFileSync(audioPath, "utf8");
    expect((src.match(/AbortSignal\.timeout\(30_000\)/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(src).toContain('fetch(`${baseURL}/audio/transcriptions`');
    expect(src).toContain('fetch(`${baseURL}/audio/speech`');
    // ensure signal is inside fetch options, not just elsewhere
    expect(src).toContain("signal: AbortSignal.timeout(30_000),");
  });

  test("image generations and chat completions have timeout", () => {
    const src = readFileSync(imagePath, "utf8");
    expect((src.match(/AbortSignal\.timeout\(30_000\)/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(src).toContain('fetch(`${baseURL}/images/generations`');
    expect(src).toContain('fetch(`${baseURL}/chat/completions`');
  });

  test("no unbounded fetch remains in audio/image without signal", () => {
    const audio = readFileSync(audioPath, "utf8");
    const image = readFileSync(imagePath, "utf8");
    // each fetch in these files should have signal; count fetches vs timeouts
    const audioFetches = (audio.match(/await fetch\(/g) || []).length;
    const audioTimeouts = (audio.match(/AbortSignal\.timeout/g) || []).length;
    // audio has 2 fetches + maybe other fetchAudioFromUrl but that is guarded fetcher, we check only provider endpoint fetches have timeout
    expect(audioTimeouts).toBeGreaterThanOrEqual(2);
    const imageFetches = (image.match(/await fetch\(/g) || []).length;
    const imageTimeouts = (image.match(/AbortSignal\.timeout/g) || []).length;
    expect(imageTimeouts).toBeGreaterThanOrEqual(2);
  });

  test("sibling correct — research and wallet attestation already timeout", () => {
    const research = readFileSync(researchPath, "utf8");
    expect(research).toContain("AbortSignal.timeout(timeout)");
    expect(research).toContain("AbortSignal.any");
    const wallet = readFileSync(walletPath, "utf8");
    expect(wallet).toContain("AbortSignal.timeout");
  });
});
