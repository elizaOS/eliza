import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

function readRoute(): string {
  // route.ts is in same dir as this test; use import.meta.url to resolve
  const p = new URL("./route.ts", import.meta.url).pathname;
  // handle encoded brackets if needed
  const decoded = decodeURIComponent(p);
  return readFileSync(decoded, "utf8");
}

describe("voice STT fetch timeout strict", () => {
  it("deepgram fetch is bounded with AbortSignal.timeout", () => {
    const src = readRoute();
    // must contain deepgramTimeoutSignal and signal usage near deepgram fetch
    expect(src).toContain("deepgramTimeoutSignal");
    expect(src).toContain("AbortSignal.timeout");
    // deepgram fetch must include signal
    expect(src).toMatch(/fetch\(deepgramUrl[\s\S]{0,500}signal:\s*deepgramTimeoutSignal/);
    // timeout error mapping must exist for deepgram
    expect(src).toContain('TimeoutError');
    expect(src).toMatch(/deepgramTimeoutSignal[\s\S]{0,800}timedOut/);
  });

  it("whisper fetch is bounded with AbortSignal.timeout and try/catch", () => {
    const src = readRoute();
    expect(src).toContain("whisperTimeoutSignal");
    expect(src).toMatch(/fetch\([\s\S]{0,300}\/v1\/audio\/transcriptions[\s\S]{0,500}signal:\s*whisperTimeoutSignal/);
    // whisper must be wrapped in try/catch with timeout handling
    expect(src).toMatch(/let whisperResponse[\s\S]{0,200}try[\s\S]{0,600}whisperTimeoutSignal/);
    expect(src).toMatch(/whisperTimeoutSignal[\s\S]{0,800}TimeoutError/);
  });

  it("sibling cartesia remains bounded and json body timeout handled", () => {
    const src = readRoute();
    // sibling must still be bounded
    expect(src).toContain("cartesiaTimeoutSignal");
    expect(src).toMatch(/fetch\(CARTESIA_BATCH_STT_URL[\s\S]{0,500}signal:\s*cartesiaTimeoutSignal/);
    // both deepgram and whisper json parse must check aborted
    expect(src).toMatch(/deepgramTimeoutSignal\.aborted/);
    expect(src).toMatch(/whisperTimeoutSignal\.aborted/);
    // cartesia already checks aborted
    expect(src).toMatch(/cartesiaTimeoutSignal\.aborted/);
  });

  it("payload rejects unbounded hang and preserves 504 on timeout", () => {
    const src = readRoute();
    // count signals: deepgram, whisper, cartesia = at least 3 timeout signals
    const timeoutCount = (src.match(/AbortSignal\.timeout/g) || []).length;
    expect(timeoutCount).toBeGreaterThanOrEqual(3);
    // ensure no bare whisper fetch without signal remains
    // the old pattern `method: "POST", body: form }` without signal should not exist for whisper
    const bareWhisper = src.includes('{ method: "POST", body: form },');
    expect(bareWhisper).toBe(false);
    // ensure deepgram fetch without signal not present (bare body: buffer without signal)
    // check that deepgram fetch block contains signal
    const deepgramFetchOk = /fetch\(deepgramUrl[\s\S]*?body:\s*buffer,[\s\S]*?signal:/.test(src);
    expect(deepgramFetchOk).toBe(true);
    // status mapping 504 for timeout must be present at least twice (deepgram+whisper)
    const count504 = (src.match(/status:\s*timedOut \? 504/g) || []).length;
    expect(count504).toBeGreaterThanOrEqual(2);
  });
});
