import { beforeEach, expect, test, mock } from "bun:test";
const state = { attempts: [0, 0], effects: [0, 0], unknown: [0, 0], amounts: [0, 0], failTts: false, index: 0 };
mock.module("@elizaos/cloud-shared/lib/pricing-constants", () => ({ PLATFORM_MARKUP_MULTIPLIER: 1.2 }));
mock.module("@elizaos/cloud-shared/lib/services/organization-inference-admission", () => ({
  admitOrganizationInference: async () => {
    const index = state.index++;
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
beforeEach(() => Object.assign(state, { attempts: [0, 0], effects: [0, 0], unknown: [0, 0], amounts: [0, 0], failTts: false, index: 0 }));
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
