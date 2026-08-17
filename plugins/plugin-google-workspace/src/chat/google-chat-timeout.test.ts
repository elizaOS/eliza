/**
 * Proves Google Chat provider fetch timeout (rank 8 clone of cloud atlas/fal/openai batches).
 * All 6 external fetches now have AbortSignal.timeout(CHAT_FETCH_TIMEOUT_MS) matching cloud discipline.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const chatPath = new URL("./service.ts", import.meta.url).pathname;
const sunoPath = new URL("../../../../packages/cloud/shared/src/lib/providers/audio/suno-audio-generation.ts", import.meta.url).pathname;

describe("google chat fetch timeout — bounded connector", () => {
  test("chat fetches have AbortSignal.timeout", () => {
    const src = readFileSync(chatPath, "utf8");
    expect(src).toContain("const CHAT_FETCH_TIMEOUT_MS = 30_000;");
    expect(src).toContain("signal: AbortSignal.timeout(CHAT_FETCH_TIMEOUT_MS),");
    const timeouts = (src.match(/AbortSignal\.timeout\(CHAT_FETCH_TIMEOUT_MS\)/g) || []).length;
    expect(timeouts).toBeGreaterThanOrEqual(6);
    expect(src).toContain("AbortSignal.any([init.signal, timeoutSignal])");
  });

  test("fetchApi merges caller signal with timeout via AbortSignal.any", () => {
    const src = readFileSync(chatPath, "utf8");
    expect(src).toContain("const timeoutSignal = AbortSignal.timeout(CHAT_FETCH_TIMEOUT_MS);");
    expect(src).toContain("AbortSignal.any([init.signal, timeoutSignal])");
    expect(src).toContain("private async fetchApi<T>(url: string, init: RequestInit");
  });

  test("no unbounded fetch remains in chat service", () => {
    const src = readFileSync(chatPath, "utf8");
    const fetches = (src.match(/await fetch\(/g) || []).length;
    const timeouts = (src.match(/AbortSignal\.timeout/g) || []).length;
    expect(timeouts).toBeGreaterThanOrEqual(fetches);
    expect(fetches).toBe(6);
  });

  test("sibling correct — suno image already bounded", () => {
    const suno = readFileSync(sunoPath, "utf8");
    expect(suno).toContain("AbortSignal.timeout");
  });
});
