/**
 * Cerebras judge error truncation — local diagnostic hygiene.
 *
 * `errBody` is the inbound HTTP error body read after Cerebras has already
 * responded with a non-2xx status; it is used only to construct a local
 * `CerebrasJudgeError` diagnostic string and is never sent outbound through
 * Cerebras serde. A naive `slice(0, 300)` landing mid-surrogate leaves a lone
 * surrogate in the local error message, polluting logs/diagnostics with
 * ill-formed Unicode. The fix keeps the diagnostic well-formed.
 *
 * These tests drive the real `CerebrasJudge` failed-fetch path with a mocked
 * `fetch` and assert the thrown `CerebrasJudgeError.message` is well-formed
 * and backs off correctly — reverting the production line to `slice` leaves
 * them red.
 */

import { toWellFormedUnicode } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CerebrasJudge } from "./cerebras-judge.ts";

const ORIGINAL_FETCH = globalThis.fetch;

const isWellFormed = (s: string): boolean => {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
};

function mockErrorOnce(status: number, body: string): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(body, {
      status,
      headers: { "Content-Type": "text/plain" },
    }),
  );
}

async function assertThrownMessage(
  errBody: string,
  status = 400,
): Promise<string> {
  mockErrorOnce(status, errBody);
  const judge = new CerebrasJudge({
    apiKey: "test-key-for-surrogate-path",
    baseUrl: "https://api.cerebras.ai/v1",
    maxRetries: 0,
  });
  let message = "";
  try {
    await judge.judge("test prompt for surrogate coverage");
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  if (!message) throw new Error("expected CerebrasJudgeError to be thrown");
  return message;
}

describe("cerebras-judge errBody 300 diagnostic hygiene (mocked judge path)", () => {
  const R = "🦊";

  beforeEach(() => {
    process.env.CEREBRAS_API_KEY = "test-key-for-surrogate-path";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("300 cap backs off mid-pair via thrown CerebrasJudgeError", async () => {
    const errBody = `${"a".repeat(299)}${R}b`;
    const message = await assertThrownMessage(errBody, 400);
    expect(isWellFormed(message)).toBe(true);
    expect(() => JSON.stringify(message)).not.toThrow();
    const prefix = "cerebras error 400: ";
    expect(message.startsWith(prefix)).toBe(true);
    const truncated = message.slice(prefix.length);
    // Naive slice(0,300) would leave a lone high surrogate (length 300 ill-formed);
    // well-formed truncation backs off to 299.
    expect(truncated.length).toBe(299);
    expect(isWellFormed(truncated)).toBe(true);
  });

  it("preserves fitting emoji at 300 via thrown error", async () => {
    const errBody = `${"a".repeat(298)}${R}`;
    const message = await assertThrownMessage(errBody, 400);
    const truncated = message.slice("cerebras error 400: ".length);
    expect(truncated).toBe(errBody);
    expect(isWellFormed(message)).toBe(true);
  });

  it("sweep 0..65 at 300 stays well-formed via judge path", async () => {
    for (let off = 0; off <= 65; off++) {
      const errBody = `${"a".repeat(off)}${R}${"b".repeat(500)}`;
      const message = await assertThrownMessage(errBody, 400);
      expect(isWellFormed(message)).toBe(true);
      expect(() => JSON.stringify(message)).not.toThrow();
      // Must not contain a lone high surrogate without its pair.
      expect(message.includes("\ud83d") && !message.includes(R)).toBe(false);
    }
  });

  it("lone surrogate in inbound body is sanitised in thrown error", async () => {
    const errBody = `ok \ud83d end ${"x".repeat(500)}`;
    const message = await assertThrownMessage(errBody, 400);
    expect(isWellFormed(message)).toBe(true);
    expect(message.includes("\ud83d")).toBe(false);
    expect(message.includes("�")).toBe(true);
  });

  it("thrown error message stays well-formed and JSON-stringify-safe", async () => {
    const errBody = `${"a".repeat(299)}${R}${"b".repeat(100)}`;
    const message = await assertThrownMessage(errBody, 500);
    // 500 without retries would normally retry; maxRetries:0 ensures single throw.
    // Re-test with 400 to also cover prefix accounting.
    const message400 = await assertThrownMessage(errBody, 400);
    for (const msg of [message, message400]) {
      expect(isWellFormed(msg)).toBe(true);
      expect(() => JSON.stringify(msg)).not.toThrow();
      // Stringify must not produce an escaped lone surrogate illusion — the
      // source string itself must be well-formed; JSON.stringify would escape
      // a lone surrogate rather than throw.
      expect(msg.includes("\ud83d") && !msg.includes(R)).toBe(false);
    }
  });
});
