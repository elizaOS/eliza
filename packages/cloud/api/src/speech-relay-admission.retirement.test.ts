import { beforeEach, expect, test, mock } from "bun:test";
class InsufficientCreditsError extends Error {}
class InferenceBalanceCacheWarmingError extends Error {}
mock.module("@elizaos/cloud-shared/lib/services/inference-billing-fast-path", () => ({ InferenceBalanceCacheWarmingError }));
mock.module("@elizaos/cloud-shared/lib/services/credits", () => ({ InsufficientCreditsError }));
const state = { attempts: [0, 0], effects: [0, 0], unknown: [0, 0], amounts: [0, 0], failTts: false, index: 0, failAt: -1, failure: undefined as Error | undefined };
mock.module("@elizaos/cloud-shared/lib/pricing-constants", () => ({ PLATFORM_MARKUP_MULTIPLIER: 1.2 }));
mock.module("@elizaos/cloud-shared/lib/services/organization-inference-admission", () => ({
  admitOrganizationInference: async () => {
    const index = state.index++;
    if (index === state.failAt) throw state.failure;
    return {
      async settle(value: number) {
        state.attempts[index]++;
        if (index === 1 && state.failTts) { state.failTts = false; throw Error("TTS settlement unavailable"); }
        state.effects[index]++; state.amounts[index] = value;
      },
      async settleUnknown() { state.unknown[index]++; },
      async markProviderDispatched() {},
    };
  },
}));
const { reserveSpeechRelayAdmission } = await import("./speech-relay-admission");
beforeEach(() => Object.assign(state, { attempts: [0, 0], effects: [0, 0], unknown: [0, 0], amounts: [0, 0], failTts: false, index: 0, failAt: -1, failure: undefined }));
const caller = { user: { id: "owner", organization_id: "org" }, credential: {} } as never;
const details = () => ({ pcmBytes: 32000, ttsCharacters: 3, providerMayHaveStarted: true, outcomes: { stt: "complete", tts: "complete" } as const, dispatched: { stt: true, tts: true } });
const reserve = (onProgress?: Parameters<typeof reserveSpeechRelayAdmission>[0]["onProgress"]) => reserveSpeechRelayAdmission({ caller, sessionId: "session", usdPerCredit: 0.001, executionCtx: { waitUntil() {} }, onProgress });
test("partial settlement retry does not repeat successful STT money", async () => {
  const admission = await reserve(); state.failTts = true;
  await expect(admission.settle(details())).rejects.toThrow();
  await admission.settle(details());
  expect(state.effects).toEqual([1, 1]); expect(state.attempts).toEqual([1, 2]);
  expect(state.amounts).toEqual([0.0036, 0.0036]);
});
test("reserved but not dispatched reconciles both kinds to actual zero", async () => {
  const admission = await reserve();
  const result = await admission.settle({ ...details(), dispatched: { stt: false, tts: false } });
  expect(state.amounts).toEqual([0, 0]); expect(result).toMatchObject({ stt: { state: "actual", amountUsd: "0" }, tts: { state: "actual", amountUsd: "0" } });
});
test("proof-write failure retries persistence without repeating money", async () => {
  let fail = true;
  const admission = await reserve(async (kind, progress) => {
    if (kind === "stt" && progress.state === "settled_actual" && fail) { fail = false; throw Error("proof write failed"); }
  });
  await expect(admission.settle(details())).rejects.toThrow();
  await admission.settle(details()); expect(state.effects).toEqual([1, 1]);
});
test("conservative STT remains explicitly different from actual", async () => {
  const admission = await reserve();
  const result = await admission.settle({ ...details(), outcomes: { stt: "unknown", tts: "complete" } });
  expect(result).toMatchObject({ stt: { state: "conservative" }, tts: { state: "actual" } });
  expect(state.unknown).toEqual([1, 0]);
});
test("changed settlement target is refused on retry", async () => {
  const admission = await reserve(); state.failTts = true;
  await expect(admission.settle(details())).rejects.toThrow();
  await expect(admission.settle({ ...details(), pcmBytes: 64000 })).rejects.toThrow("target changed");
  expect(state.effects[0]).toBe(1);
});

test("proven STT settles while unknown TTS keeps its target undecided", async () => {
  const admission = await reserve();
  const partial = await admission.settle(details(), ["stt"]);
  expect(partial).toMatchObject({ stt: { state: "actual" } });
  expect(partial?.tts).toBeUndefined(); expect(state.effects).toEqual([1, 0]);
  await admission.settle({ ...details(), ttsCharacters: 0, dispatched: { stt: true, tts: false } });
  expect(state.effects).toEqual([1, 1]); expect(state.amounts[1]).toBe(0);
});
test("pre-lease warming records no reservation", async () => {
  state.failAt = 0; state.failure = new InferenceBalanceCacheWarmingError(); const progress: unknown[] = [];
  await expect(reserve(async (kind, value) => { progress.push([kind, value.state]); })).rejects.toBe(state.failure);
  expect(progress).toEqual([["stt", "reserving"], ["stt", "not_reserved"]]);
});
test("failed no-reservation proof cannot skip rollback or hide its primary cause", async () => {
  state.failAt = 1; state.failure = new InsufficientCreditsError("denied");
  const failure = await reserve(async (_kind, value) => { if (value.state === "not_reserved") throw Error("proof write failed"); }).catch(error => error);
  expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors).toContain(state.failure);
  expect(state.effects[0]).toBe(1); expect(state.amounts[0]).toBe(0);
});

test("a warming-shaped progress error cannot claim no reservation", async () => {
  const progress: string[] = [];
  await expect(reserve(async (_kind, value) => { progress.push(value.state); if (value.state === "reserving") throw new InferenceBalanceCacheWarmingError(); })).rejects.toBeInstanceOf(InferenceBalanceCacheWarmingError);
  expect(progress).toEqual(["reserving"]);
});

test("a fixed conservative STT target does not block later TTS settlement", async () => {
  const admission = await reserve();
  await admission.settle({ ...details(), outcomes: { stt: "unknown", tts: "unknown" } }, ["stt"]);
  const result = await admission.settle(details(), ["tts"]);
  expect(result?.stt?.state).toBe("conservative"); expect(result?.tts?.state).toBe("actual");
  expect(state.unknown).toEqual([1, 0]); expect(state.effects).toEqual([0, 1]);
});

test("real session and admission preserve conservative STT after lost progress ack", async () => {
  const { createSpeechRelaySession } = await import("@elizaos/host/voice/speech-relay-session");
  let handle: any, drained = false, ttsClosed = false, failProof = true;
  const admission = await reserve(async (kind, progress) => {
    if (kind === "stt" && progress.state === "settled_conservative" && failProof) {
      failProof = false; throw Error("conservative receipt write failed");
    }
  });
  const session = await createSpeechRelaySession({ organizationId: "org", userId: "owner", cloudSessionId: "session" }, "consent", {
    enabled: true, assertCurrent() {}, consumeConsent: async () => true,
    usageStore: { checkAndRecord: async () => ({ allowed: true }), release: async () => {} } as never,
    usageLimits: {} as never, subscribeRevoked: () => () => {}, registerRetirement: value => { handle = value; },
    reserveCredits: async () => admission,
    openStt: () => ({ sendAudioChunk() {}, cancel() {}, drain: async () => {
      if (!drained) throw Error("drain unknown");
      return { source: "provider-graceful-close", audioBytes: 0, sampleRate: 16000, channels: 1, encoding: "pcm_s16le" } as const;
    } }),
    openTts: () => ({ sendPhrase() {}, finish() {}, cancel() {} }),
    confirmTtsTransportStopped: async () => ttsClosed ? "transport_closed" : "unknown",
    emit() {}, onClosed(promise) { void promise.catch(() => {}); },
  });
  await session.control({ t: "prepare", id: "context" });
  await expect(session.close()).rejects.toThrow();
  expect(state.unknown).toEqual([1, 0]); expect(state.effects).toEqual([0, 0]);
  drained = true; ttsClosed = true; await handle.retryRetirement();
  expect(state.unknown).toEqual([1, 0]); expect(state.effects).toEqual([0, 1]);
  expect(handle.evidence().accounting).toBe("unknown");
});
