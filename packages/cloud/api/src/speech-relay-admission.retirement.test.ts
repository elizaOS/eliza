import { beforeEach, expect, test, mock } from "bun:test";
import { InMemoryVoiceUsageStore } from "@elizaos/host/voice/usage";
class InsufficientCreditsError extends Error {}
class InferenceBalanceCacheWarmingError extends Error {}
mock.module("@elizaos/cloud-shared/lib/services/inference-billing-fast-path", () => ({ InferenceBalanceCacheWarmingError }));
mock.module("@elizaos/cloud-shared/lib/services/credits", () => ({ InsufficientCreditsError }));
const state = { attempts: [0, 0], effects: [0, 0], unknown: [0, 0], amounts: [0, 0], failTts: false, index: 0, failAt: -1, failure: undefined as Error | undefined, receiptFault: "", dispatchMarks: 0 };
mock.module("@elizaos/cloud-shared/lib/pricing-constants", () => ({ PLATFORM_MARKUP_MULTIPLIER: 1.2 }));
mock.module("@elizaos/cloud-shared/lib/services/organization-inference-admission", () => ({
  admitOrganizationInference: async (input: any) => {
    const index = state.index++;
    if (index === state.failAt) throw state.failure;
    return {
      mode: state.receiptFault === "funded" ? "durable_object_funded_budget" : "durable_object_debit",
      async settle(value: number) {
        state.attempts[index]++;
        if (index === 1 && state.failTts) { state.failTts = false; throw Error("TTS settlement unavailable"); }
        state.effects[index]++; state.amounts[index] = value;
        if (state.receiptFault === "null") return null;
        if (state.receiptFault === "void") return;
        return { terminalReceipt: { version: 1,
          organizationId: state.receiptFault === "owner" ? "another-org" : input.context.organizationId,
          requestId: state.receiptFault === "request" ? "another-request" : input.context.requestId,
          amountUsd: state.receiptFault === "amount" ? "999.000000" : value.toFixed(6),
          mode: state.receiptFault === "mode" ? "synchronous_db_ledger" : state.receiptFault === "funded" ? "durable_object_funded_budget" : "durable_object_debit", status: "canonical_completed" } };
      },
      async settleUnknown() { state.unknown[index]++; },
      async markProviderDispatched() { state.dispatchMarks++; },
    };
  },
}));
const { reserveSpeechRelayAdmission } = await import("./speech-relay-admission");
const resetAdmissionFixture = () => Object.assign(state, { attempts: [0, 0], effects: [0, 0], unknown: [0, 0], amounts: [0, 0], failTts: false, index: 0, failAt: -1, failure: undefined, receiptFault: "", dispatchMarks: 0 });
beforeEach(resetAdmissionFixture);
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

test("unknown-provider submitted TTS counter settles once without becoming actual evidence", async () => {
  const admission = await reserve();
  const value = { ...details(), ttsCharacters: 3, ttsAccountingBasis: "submitted_counter_provider_unconfirmed" as const };
  const result = await admission.settle(value, ["tts"]);
  expect(result?.tts).toMatchObject({ state: "conservative", amountUsd: "0.0036", basis: "submitted_counter_provider_unconfirmed" });
  await admission.settle(value, ["tts"]);
  expect(state.effects).toEqual([0, 1]); expect(state.unknown).toEqual([0, 0]);
  await expect(admission.settle({ ...value, ttsCharacters: 4 }, ["tts"])).rejects.toThrow("target changed");
});

test("canonical matched speech receipts are terminal after actual settlement", async () => {
  const result = await (await reserve()).settle(details());
  expect(result?.stt?.terminal).toBe(true); expect(result?.tts?.terminal).toBe(true);
});

test.each(["owner", "request", "amount", "mode"])("a mismatched canonical %s receipt is not terminal speech evidence", async fault => {
  state.receiptFault = fault;
  const result = await (await reserve()).settle(details());
  expect(result?.stt?.terminal).toBeUndefined(); expect(result?.tts?.terminal).toBeUndefined();
});


// Controlled financial IO below stays the existing fixture boundary, not canonical SQL acceptance.
test("D1 matched zero rollback is required after a typed second-kind refusal", async () => {
  const refusal = new InsufficientCreditsError("TTS refused before reservation");
  state.failAt = 1; state.failure = refusal;
  const progress: { kind: string; state: string; requestId?: string; amountUsd?: string }[] = [];
  await expect(reserve(async (kind, value) => { progress.push({ kind, ...value }); })).rejects.toBe(refusal);
  expect(state.effects).toEqual([1, 0]);
  expect(state.amounts).toEqual([0, 0]);
  expect(state.dispatchMarks).toBe(0);
  expect(progress).toContainEqual({ kind: "tts", state: "not_reserved" });
  expect(progress).toContainEqual({ kind: "stt", state: "settled_actual", requestId: "speech:session:stt", amountUsd: "0" });
  expect(state.unknown).toEqual([0, 0]);
});

test("D1 ambiguous zero rollback preserves the original refusal and unconfirmed money", async () => {
  for (const fault of ["owner", "request", "amount", "mode", "funded", "null", "void"]) {
    resetAdmissionFixture();
    const refusal = new InsufficientCreditsError(`primary refusal ${fault}`);
    state.failAt = 1; state.failure = refusal; state.receiptFault = fault;
    const progress: string[] = [];
    const failure = await reserve(async (_kind, value) => { progress.push(value.state); }).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw Error("Expected aggregate rollback refusal");
    expect(failure.errors).toContain(refusal);
    expect(progress).toContain("unconfirmed");
    expect(progress).not.toContain("settled_actual");
    expect(state.effects).toEqual([1, 0]);
    expect(state.dispatchMarks).toBe(0);
  }
});

test("D1 zero settlement retries lost progress acknowledgement without a second monetary effect", async () => {
  let fail = true;
  const written: string[] = [];
  const admission = await reserve(async (kind, value) => {
    if (kind === "stt" && value.state === "settled_actual" && fail) { fail = false; throw Error("zero progress ACK lost"); }
    written.push(`${kind}:${value.state}`);
  });
  const zero = { ...details(), dispatched: { stt: false, tts: false } };
  await expect(admission.settle(zero)).rejects.toThrow("zero progress ACK lost");
  const result = await admission.settle(zero);
  expect(result).toMatchObject({ stt: { state: "actual", terminal: true, amountUsd: "0" }, tts: { state: "actual", terminal: true, amountUsd: "0" } });
  expect(state.attempts).toEqual([1, 1]); expect(state.effects).toEqual([1, 1]);
  expect(written).toContain("stt:settled_actual");
  await expect(admission.settle({ ...zero, dispatched: { stt: true, tts: false } })).rejects.toThrow("target changed");
  expect(state.effects).toEqual([1, 1]);
});

test("D3 late proven TTS close confirms the same frozen charge without another settlement", async () => {
  const { createSpeechRelaySession } = await import("@elizaos/host/voice/speech-relay-session");
  let handle: import("@elizaos/host/voice/speech-relay-session").SpeechRelayRetirementHandle | undefined;
  let closed = false, sttOpens = 0, ttsOpens = 0;
  const progress: unknown[] = []; let loseConservativeAck = true;
  const admission = await reserve(async (kind, value) => {
    if (kind === "tts" && value.state === "settled_conservative" && loseConservativeAck) {
      loseConservativeAck = false; throw Error("conservative progress ACK lost");
    }
    if (kind === "tts") progress.push(structuredClone(value));
  });
  const session = await createSpeechRelaySession({ organizationId: "org", userId: "owner", cloudSessionId: "session" }, "consent", {
    enabled: true, assertCurrent() {}, consumeConsent: async () => true,
    usageStore: new InMemoryVoiceUsageStore(),
    usageLimits: { organizationDailyMinutes: 10, userDailyMinutes: 10 }, subscribeRevoked: () => () => {}, registerRetirement(value) { handle = value; },
    reserveCredits: async () => admission,
    openStt: () => { sttOpens++; return { sendAudioChunk() {}, cancel() {}, drain: async () => ({ source: "provider-graceful-close", audioBytes: 0, sampleRate: 16000, channels: 1, encoding: "pcm_s16le" } as const) }; },
    openTts: () => { ttsOpens++; return { sendPhrase() {}, finish() {}, cancel() {} }; },
    confirmTtsTransportStopped: async () => closed ? "transport_closed" : "unknown",
    emit() {}, onClosed(value) { void value.catch(() => {}); },
  });
  await session.control({ t: "tts", id: "frozen", text: "hello" });
  await expect(session.close()).rejects.toThrow();
  if (!handle?.finalizeUnknownTtsAccounting) throw Error("Missing registered real retirement handle");
  await expect(handle.finalizeUnknownTtsAccounting()).rejects.toThrow("conservative progress ACK lost");
  expect(state.effects).toEqual([1, 1]);
  await handle.finalizeUnknownTtsAccounting();
  expect(state.attempts).toEqual([1, 1]);
  expect(handle.evidence()).toMatchObject({ tts: "unknown", accounting: "unknown" });
  expect(state.effects).toEqual([1, 1]); expect(state.amounts).toEqual([0, 0.006]);
  const before = JSON.stringify(progress);
  closed = true;
  await handle.retryRetirement();
  expect(handle.evidence()).toMatchObject({ stt: "gracefully_drained", tts: "transport_closed", accounting: "settled_actual", moneyTerminal: true });
  expect(state.effects).toEqual([1, 1]); expect(state.attempts).toEqual([1, 1]);
  expect(JSON.stringify(progress)).toBe(before);
  expect(progress).toContainEqual({ state: "settled_conservative", requestId: "speech:session:tts", amountUsd: "0.006", basis: "submitted_counter_provider_unconfirmed" });
  expect([sttOpens, ttsOpens]).toEqual([1, 1]);
});

test("D3 frozen TTS target cannot change count basis or dispatch state after finalization", async () => {
  const admission = await reserve();
  const frozen = { ...details(), ttsCharacters: 5, ttsAccountingBasis: "submitted_counter_provider_unconfirmed" as const };
  await admission.settle(frozen, ["tts"]);
  for (const changed of [
    { ...frozen, ttsCharacters: 6 },
    { ...frozen, ttsAccountingBasis: undefined },
    { ...frozen, dispatched: { stt: true, tts: false } },
    { ...frozen, outcomes: { stt: "complete" as const, tts: "unknown" as const } },
  ]) await expect(admission.settle(changed, ["tts"])).rejects.toThrow("target changed");
  await admission.settle(frozen, ["tts"]);
  expect(state.effects).toEqual([0, 1]); expect(state.amounts[1]).toBe(0.006);
});
