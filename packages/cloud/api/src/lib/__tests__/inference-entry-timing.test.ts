import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import {
  isInferenceEntryTimingEnabled,
  prepareInferenceEntryRequest,
  recordInferenceEntryPhase,
  timeInferenceEntryPhase,
} from "../../inference-entry-timing";

const traceId = "1234567890abcdef1234567890abcdef";
const path = "/api/v1/voice/stt";
const audit = spyOn(logger, "audit").mockImplementation(() => {});
afterEach(() => {
  audit.mockClear();
  audit.mockImplementation(() => {});
});
afterAll(() => audit.mockRestore());

test("timing is off unless both staging identity and measured path match", async () => {
  for (const environment of [
    undefined,
    null,
    "production",
    "test",
    "Staging",
    "staging ",
  ]) {
    const request = new Request(`https://api.eliza.app${path}`, {
      method: "POST",
      body: "unchanged",
    });
    expect(isInferenceEntryTimingEnabled(environment, path)).toBe(false);
    expect(prepareInferenceEntryRequest(request, environment)).toBe(request);
    const result = {};
    expect(
      await timeInferenceEntryPhase(
        environment,
        traceId,
        path,
        "app_wait",
        async () => result,
      ),
    ).toBe(result);
    recordInferenceEntryPhase({
      environment,
      traceId,
      path,
      phase: "fetch_enter",
      durationMs: 0,
      outcome: "entered",
    });
  }
  const unmeasured = new Request("https://api-staging.eliza.app/api/health");
  expect(prepareInferenceEntryRequest(unmeasured, "staging")).toBe(unmeasured);
  expect(audit).not.toHaveBeenCalled();
});

test("staging request decoration preserves body, method, headers and linked abort", async () => {
  const controller = new AbortController();
  const bytes = new Uint8Array([0, 1, 2, 254, 255]);
  const request = new Request(`https://api-staging.eliza.app${path}`, {
    method: "POST",
    body: bytes,
    headers: { "content-type": "audio/wav", "x-request-id": "retained" },
    signal: controller.signal,
  });
  const prepared = prepareInferenceEntryRequest(request, "staging");
  expect(prepared.method).toBe("POST");
  expect(prepared.headers.get("content-type")).toBe("audio/wav");
  expect(prepared.headers.get("x-request-id")).toBe("retained");
  expect(prepared.headers.get("x-eliza-trace-id")).toMatch(/^[0-9a-f]{32}$/);
  expect(new Uint8Array(await prepared.arrayBuffer())).toEqual(bytes);
  controller.abort();
  expect(prepared.signal.aborted).toBe(true);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const abortedRequest = new Request(`https://api-staging.eliza.app${path}`, {
    signal: alreadyAborted.signal,
  });
  expect(
    prepareInferenceEntryRequest(abortedRequest, "staging").signal.aborted,
  ).toBe(true);
});

test("valid staging trace retains the original request", () => {
  const request = new Request(`https://api-staging.eliza.app${path}`, {
    headers: { "x-eliza-trace-id": traceId },
  });
  expect(prepareInferenceEntryRequest(request, "staging")).toBe(request);
});

test("creator and joining request waits retain their own trace, including shared rejection", async () => {
  for (const rejected of [false, true]) {
    let resolve!: (value: object) => void;
    let reject!: (error: Error) => void;
    const shared = new Promise<object>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const joiningTrace = "abcdef1234567890abcdef1234567890";
    const creator = timeInferenceEntryPhase(
      "staging",
      traceId,
      path,
      "app_wait",
      () => shared,
    );
    const joiner = timeInferenceEntryPhase(
      "staging",
      joiningTrace,
      path,
      "app_wait",
      () => shared,
    );
    const settled = Promise.allSettled([creator, joiner]);
    const result = {};
    const error = new Error("private failure");
    if (rejected) reject(error);
    else resolve(result);
    const outcomes = await settled;
    for (const outcome of outcomes) {
      if (rejected) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") expect(outcome.reason).toBe(error);
      } else {
        expect(outcome.status).toBe("fulfilled");
        if (outcome.status === "fulfilled") expect(outcome.value).toBe(result);
      }
    }
    expect(audit.mock.calls.slice(-2).map((call) => call[1])).toEqual([
      expect.objectContaining({
        traceId,
        outcome: rejected ? "threw" : "returned",
      }),
      expect.objectContaining({
        traceId: joiningTrace,
        outcome: rejected ? "threw" : "returned",
      }),
    ]);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(error.message);
  }
});

test("logger failure never changes the operation", async () => {
  audit.mockImplementation(() => {
    throw new Error("logger failed");
  });
  const value = {};
  expect(
    await timeInferenceEntryPhase(
      "staging",
      traceId,
      path,
      "shell_import",
      async () => value,
    ),
  ).toBe(value);
});

test("only closed routes and finite timings enter diagnostics", () => {
  for (const durationMs of [NaN, Infinity, -1, Number.MAX_VALUE])
    recordInferenceEntryPhase({
      environment: "staging",
      traceId,
      path,
      phase: "ingress_decision",
      durationMs,
      outcome: "allowed",
    });
  recordInferenceEntryPhase({
    environment: "staging",
    traceId,
    path: "toString",
    phase: "dispatch_enter",
    durationMs: 0,
    outcome: "entered",
  });
  expect(audit).not.toHaveBeenCalled();
  recordInferenceEntryPhase({
    environment: "staging",
    traceId: "private-token",
    path,
    phase: "ingress_decision",
    durationMs: 20,
    outcome: "allowed",
    ingress: "timeout",
  });
  expect(audit.mock.calls[0]?.[1]).toEqual({
    schema: "inference_entry_phase_v1",
    traceId: "unavailable",
    route: "stt",
    phase: "ingress_decision",
    durationMs: 20,
    outcome: "allowed",
    ingress: "timeout",
  });
  expect(JSON.stringify(audit.mock.calls)).not.toContain("private-token");
});
