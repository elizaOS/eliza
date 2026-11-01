import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppContext } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { timeSpeechPhase } from "../generative-route-auth";
const traceA = "a".repeat(32), traceB = "b".repeat(32);
const context = (trace: unknown = traceA, path = "/api/v1/voice/stt") => ({
  req: { url: "https://api-staging.eliza.app" + path },
  get: (key: string) => key === "traceId" ? trace : undefined,
}) as AppContext;
afterEach(() => mock.restore());
describe("speech phase diagnostics preserve business outcomes", () => {
  it("preserves success identity and calls the operation once", async () => {
    const log = spyOn(logger, "audit").mockImplementation(() => {});
    const value = {}, run = mock(async () => value);
    expect(await timeSpeechPhase(context(), "upload_read", run)).toBe(value);
    expect(run).toHaveBeenCalledTimes(1); expect(log).toHaveBeenCalledTimes(1);
    const fields = log.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual(["durationMs", "outcome", "phase", "route", "schema", "traceId"]);
    expect(fields).toMatchObject({ traceId: traceA, phase: "upload_read", route: "stt", outcome: "returned" });
    expect(Number.isFinite(fields.durationMs)).toBe(true);
  });
  it("preserves original error identity even if the logger also throws", async () => {
    spyOn(logger, "audit").mockImplementation(() => { throw new Error("logger failure"); });
    const error = new Error("PRIVATE_DIAGNOSTIC_MUST_NOT_APPEAR");
    const run = mock(async () => { throw error; });
    await expect(timeSpeechPhase(context(), "audio_sniff", run)).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("does not reject successful work when logging fails", async () => {
    spyOn(logger, "audit").mockImplementation(() => { throw new Error("logger failure"); });
    const result = {};
    expect(await timeSpeechPhase(context(), "audio_buffer", async () => result)).toBe(result);
  });
  it("keeps concurrent trace IDs isolated", async () => {
    const log = spyOn(logger, "audit").mockImplementation(() => {});
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    const first = timeSpeechPhase(context(traceA), "auth_resolution", () => pending);
    await timeSpeechPhase(context(traceB), "auth_resolution", async () => {}); release(); await first;
    expect(log.mock.calls.map(call => (call[1] as { traceId: string }).traceId)).toEqual([traceB, traceA]);
  });
  it("does not emit for nonspeech or unknown runtime phases", async () => {
    const log = spyOn(logger, "audit").mockImplementation(() => {}); const run = mock(async () => 1);
    expect(await timeSpeechPhase(context(traceA, "/api/v1/chat/completions"), "json_decode", run)).toBe(1);
    expect(await timeSpeechPhase(context(), "UNTRUSTED_PHASE" as never, run)).toBe(1);
    expect(log).not.toHaveBeenCalled(); expect(run).toHaveBeenCalledTimes(2);
  });
  it("does not repeat synchronously throwing nonspeech work", async () => {
    const error = new Error("same error"); const run = mock(() => { throw error; });
    await expect(timeSpeechPhase(context(traceA, "/other"), "json_decode", run)).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("replaces malformed trace IDs without logging their content or thrown text", async () => {
    const log = spyOn(logger, "audit").mockImplementation(() => {});
    const secret = "private-token-".repeat(1000), error = new Error(secret);
    await expect(timeSpeechPhase(context(secret), "json_decode", async () => { throw error; })).rejects.toBe(error);
    expect(log.mock.calls[0][1]).toMatchObject({ traceId: "unavailable", outcome: "threw" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-token");
  });
});
