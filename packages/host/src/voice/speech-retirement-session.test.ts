import { expect, test } from "vitest";
import { createSpeechRelaySession, type SpeechRelayPorts, type SpeechRelayRetirementHandle } from "./speech-relay-session";
function ports() {
  let handle!: SpeechRelayRetirementHandle;
  let unknownDrain = false, settlementFails = false, money = 0;
  const value: SpeechRelayPorts = {
    enabled: true, assertCurrent() {}, consumeConsent: async () => true,
    usageStore: { checkAndRecord: async () => ({ allowed: true }), release: async () => {} } as never,
    usageLimits: {} as never, subscribeRevoked: () => () => {},
    registerRetirement: value => { handle = value; },
    reserveCredits: async () => ({ beforeProviderDispatch: async () => {}, settle: async details => {
      if (settlementFails) { settlementFails = false; throw Error("settlement failed"); }
      money++;
      return { stt: { state: details.outcomes?.stt === "complete" ? "actual" : "conservative", requestId: "stt", amountUsd: "0" }, tts: { state: "actual", requestId: "tts", amountUsd: "0" } };
    } }),
    openStt: () => ({ sendAudioChunk() {}, cancel() {}, drain: async () => {
      if (unknownDrain) throw Error("no trusted drain");
      return { source: "provider-graceful-close", audioBytes: 0, sampleRate: 16000, channels: 1, encoding: "pcm_s16le" } as const;
    } }),
    openTts: () => ({ sendPhrase() {}, finish() {}, cancel() {} }),
    confirmTtsTransportStopped: async () => "transport_closed", emit() {}, onClosed(result) { void result.catch(() => {}); },
  };
  return { value, get handle() { return handle; }, failDrain() { unknownDrain = true; }, failSettlement() { settlementFails = true; }, get money() { return money; } };
}
const identity = { organizationId: "org", userId: "owner", cloudSessionId: "session" };
test("trusted STT drain and actual settlement yield explicit evidence", async () => {
  const p = ports(); const session = await createSpeechRelaySession(identity, "consent", p.value); await session.close();
  expect(p.handle.evidence()).toEqual({ stt: "gracefully_drained", tts: "not_dispatched", accounting: "settled_actual" });
});
test("unknown drain remains unknown even when conservative settlement completes", async () => {
  const p = ports(); const session = await createSpeechRelaySession(identity, "consent", p.value); p.failDrain();
  await expect(session.close()).rejects.toThrow();
  expect(p.handle.evidence()).toMatchObject({ stt: "unknown", accounting: "unknown" });
});
test("settlement failure is explicit and only an explicit retry reattempts it", async () => {
  const p = ports(); const session = await createSpeechRelaySession(identity, "consent", p.value); p.failSettlement();
  const first = session.close(); await expect(first).rejects.toThrow(); expect(session.close()).toBe(first);
  await p.handle.retryRetirement(); expect(p.handle.evidence()?.accounting).toBe("settled_actual");
});
test("shutdown waits pending credit admission and settles undispatched work", async () => {
  const p = ports(); const original = p.value.reserveCredits; let resolve!: () => void, started!: () => void;
  const entered = new Promise<void>(yes => { started = yes; });
  const wait = new Promise<void>(yes => { resolve = yes; }); p.value.reserveCredits = async (...args) => { started(); await wait; return original(...args); };
  const opening = createSpeechRelaySession(identity, "consent", p.value); void opening.catch(() => {});
  await entered;
  let closed = false; const closure = p.handle.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
  resolve(); await opening.catch(() => {}); await closure; expect(p.money).toBe(1);
  expect(p.handle.evidence()?.stt).toBe("not_dispatched");
});
test("TTS context completion without transport confirmation is not proof", async () => {
  const p = ports(); p.value.confirmTtsTransportStopped = async () => "unknown";
  const session = await createSpeechRelaySession(identity, "consent", p.value);
  await session.control({ t: "prepare", id: "context" }); await session.close();
  expect(p.handle.evidence()?.tts).toBe("unknown");
});
test("shutdown waits pending quota and does not dispatch a provider", async () => {
  const p = ports(); let release!: () => void, entered!: () => void;
  const wait = new Promise<void>(yes => { release = yes; }), started = new Promise<void>(yes => { entered = yes; });
  p.value.usageStore.checkAndRecord = (async () => { entered(); await wait; return { allowed: true }; }) as never;
  const opening = createSpeechRelaySession(identity, "consent", p.value); void opening.catch(() => {}); await started;
  const closing = p.handle.close(); release(); await opening.catch(() => {}); await closing;
  expect(p.money).toBe(0); expect(p.handle.evidence()?.stt).toBe("not_dispatched");
});
