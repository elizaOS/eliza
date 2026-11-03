import { InMemoryVoiceUsageStore } from "./usage";
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
    reserveCredits: async () => ({ supportsPerKindSettlement: true, beforeProviderDispatch: async () => {}, settle: async (details, kinds = ["stt", "tts"]) => {
      if (settlementFails) { settlementFails = false; throw Error("settlement failed"); }
      money++;
      return { ...(kinds.includes("stt") && { stt: { state: details.dispatched?.stt !== true || details.outcomes?.stt === "complete" ? "actual" as const : "conservative" as const, requestId: "stt", amountUsd: "0", terminal: true as const } }), ...(kinds.includes("tts") && { tts: { state: details.ttsAccountingBasis ? "conservative" as const : "actual" as const, requestId: "tts", amountUsd: "0", terminal: true as const, ...(details.ttsAccountingBasis ? { basis: details.ttsAccountingBasis } : {}) } }) };
    } }),
    openStt: () => ({ sendAudioChunk() {}, cancel() {}, drain: async () => {
      if (unknownDrain) throw Error("no trusted drain");
      return { source: "provider-graceful-close", audioBytes: 0, sampleRate: 16000, channels: 1, encoding: "pcm_s16le" } as const;
    } }),
    openTts: () => ({ sendPhrase() {}, finish() {}, cancel() {} }),
    confirmTtsTransportStopped: async () => "transport_closed", emit() {}, onClosed(result) { void result.catch(() => {}); },
  };
  return { value, get handle() { return handle; }, failDrain() { unknownDrain = true; }, restoreDrain() { unknownDrain = false; }, failSettlement() { settlementFails = true; }, get money() { return money; } };
}
const identity = { organizationId: "org", userId: "owner", cloudSessionId: "session" };
test("trusted STT drain and actual settlement yield explicit evidence", async () => {
  const p = ports(); const session = await createSpeechRelaySession(identity, "consent", p.value); await session.close();
  expect(p.handle.evidence()).toEqual({ stt: "gracefully_drained", tts: "not_dispatched", accounting: "settled_actual", moneyTerminal: true });
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
  resolve(); await opening.catch(() => {}); await closure; expect(p.money).toBe(2);
  expect(p.handle.evidence()?.stt).toBe("not_dispatched");
});
test("TTS context completion without transport confirmation is not proof", async () => {
  const p = ports(); p.value.confirmTtsTransportStopped = async () => "unknown";
  const session = await createSpeechRelaySession(identity, "consent", p.value);
  await session.control({ t: "prepare", id: "context" }); await expect(session.close()).rejects.toThrow("not confirmed");
  expect(p.handle.evidence()?.tts).toBe("unknown"); expect(p.handle.evidence()?.accounting).toBe("unknown"); expect(p.money).toBe(1);
  p.value.confirmTtsTransportStopped = async () => "transport_closed";
  await p.handle.retryRetirement();
  expect(p.handle.evidence()?.tts).toBe("transport_closed"); expect(p.money).toBe(2);
});
test("shutdown waits pending quota and does not dispatch a provider", async () => {
  const p = ports(); let release!: () => void, entered!: () => void;
  const wait = new Promise<void>(yes => { release = yes; }), started = new Promise<void>(yes => { entered = yes; });
  p.value.usageStore.checkAndRecord = (async () => { entered(); await wait; return { allowed: true }; }) as never;
  const opening = createSpeechRelaySession(identity, "consent", p.value); void opening.catch(() => {}); await started;
  const closing = p.handle.close(); release(); await opening.catch(() => {}); await closing;
  expect(p.money).toBe(0); expect(p.handle.evidence()?.stt).toBe("not_dispatched");
});

test("confirmed never-bound TTS cancels queued text at zero cost", async () => {
  const p = ports(); p.value.confirmTtsTransportStopped = async () => "not_dispatched";
  const reserve = p.value.reserveCredits; let settled: any;
  p.value.reserveCredits = async (...args) => { const value = await reserve(...args); return { ...value, settle: async details => { settled = details; return value.settle(details); } }; };
  const session = await createSpeechRelaySession(identity, "consent", p.value);
  await session.control({ t: "tts", id: "queued", text: "hello" }); await session.close();
  expect(settled.ttsCharacters).toBe(0); expect(settled.dispatched.tts).toBe(false);
  expect(p.handle.evidence()?.tts).toBe("not_dispatched");
});

test("a concurrent retry joins the first pending retirement", async () => {
  const p = ports(); let release!: () => void, closes = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  p.value.confirmTtsTransportStopped = async () => { closes++; await waiting; return "transport_closed"; };
  const session = await createSpeechRelaySession(identity, "consent", p.value); await session.control({ t: "prepare", id: "pending" });
  const first = session.close(); const retry = p.handle.retryRetirement(); expect(retry).toBe(first);
  release(); await first; expect(closes).toBe(1); expect(p.money).toBe(2);
});

test("ambiguous quota release is not repeated by a cleanup retry", async () => {
  const p = ports(); let releases = 0;
  p.value.reserveCredits = async () => { throw Error("admission refused"); };
  p.value.usageStore.release = (async () => { releases++; throw Error("quota release ack lost"); }) as never;
  await expect(createSpeechRelaySession(identity, "consent", p.value)).rejects.toThrow();
  await expect(p.handle.retryRetirement()).rejects.toThrow();
  expect(releases).toBe(1);
});

test("a successful quota release is not repeated after another cleanup failure", async () => {
  const p = ports(); let releases = 0, enter!: () => void, release!: () => void;
  const entered = new Promise<void>(yes => { enter = yes; });
  const waiting = new Promise<void>(yes => { release = yes; });
  const reserve = p.value.reserveCredits;
  p.value.reserveCredits = async (...args) => { enter(); await waiting; return reserve(...args); };
  p.value.usageStore.release = (async () => { releases++; }) as never;
  const opening = createSpeechRelaySession(identity, "consent", p.value); void opening.catch(() => {}); await entered;
  p.failSettlement(); const closing = p.handle.close(); release();
  await opening.catch(() => {}); await closing.catch(() => {});
  expect(releases).toBe(1); await p.handle.retryRetirement(); expect(releases).toBe(1);
});

test("late STT evidence retains its conservative charge while TTS settles once", async () => {
  const p = ports(); p.failDrain(); p.value.confirmTtsTransportStopped = async () => "unknown";
  const session = await createSpeechRelaySession(identity, "consent", p.value);
  await session.control({ t: "prepare", id: "context" });
  await expect(session.close()).rejects.toThrow(); expect(p.money).toBe(1);
  p.restoreDrain(); p.value.confirmTtsTransportStopped = async () => "transport_closed";
  await p.handle.retryRetirement();
  expect(p.money).toBe(2); expect(p.handle.evidence()?.accounting).toBe("unknown");
});

test("a lost settlement acknowledgement retries the original per-kind evidence", async () => {
  const p = ports(); p.failDrain(); p.value.confirmTtsTransportStopped = async () => "unknown";
  const reserve = p.value.reserveCredits; const sttInputs: string[] = []; let first = true;
  p.value.reserveCredits = async (...args) => {
    const admission = await reserve(...args);
    return { ...admission, settle: async (details, kinds) => {
      if (kinds?.includes("stt")) {
        sttInputs.push(details.outcomes?.stt ?? "missing");
        if (first) { first = false; throw Error("settlement acknowledgement lost"); }
      }
      return admission.settle(details, kinds);
    } };
  };
  const session = await createSpeechRelaySession(identity, "consent", p.value);
  await session.control({ t: "prepare", id: "context" });
  await expect(session.close()).rejects.toThrow();
  p.restoreDrain(); p.value.confirmTtsTransportStopped = async () => "transport_closed";
  await p.handle.retryRetirement();
  expect(sttInputs).toEqual(["unknown", "unknown"]);
  expect(p.handle.evidence()?.accounting).toBe("unknown");
});

test("final bounded retry settles the frozen submitted counter but leaves provider unknown", async () => {
  const p = ports(); p.value.confirmTtsTransportStopped = async () => "unknown";
  const reserve = p.value.reserveCredits; const ttsInputs: unknown[] = [];
  p.value.reserveCredits = async (...args) => { const admission = await reserve(...args); return { ...admission, settle: async (details, kinds) => {
    if (kinds?.includes("tts")) ttsInputs.push(details);
    return admission.settle(details, kinds);
  } }; };
  const session = await createSpeechRelaySession(identity, "consent", p.value);
  await session.control({ t: "prepare", id: "context" });
  await expect(session.close()).rejects.toThrow(); expect(ttsInputs).toHaveLength(0);
  await p.handle.finalizeUnknownTtsAccounting!();
  expect(ttsInputs).toMatchObject([{ ttsCharacters: 0, ttsAccountingBasis: "submitted_counter_provider_unconfirmed" }]);
  expect(p.handle.evidence()).toMatchObject({ tts: "unknown", accounting: "unknown" });
  await p.handle.finalizeUnknownTtsAccounting!(); expect(ttsInputs).toHaveLength(1);
});

for (const releaseCommitted of [false, true]) {
  test(`unknown quota acknowledgement preserves separate provider/money proof, committed=${releaseCommitted}`, async () => {
    const p = ports(); const store = new InMemoryVoiceUsageStore();
    const release = store.release.bind(store); let releases = 0, enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(yes => { enter = yes; }), held = new Promise<void>(yes => { finish = yes; });
    store.release = async (...args) => { releases++; if (releaseCommitted) await release(...args); throw Error("quota acknowledgement lost"); };
    p.value.usageStore = store; p.value.usageLimits = { organizationDailyMinutes: 1, userDailyMinutes: 1 };
    const reserve = p.value.reserveCredits;
    p.value.reserveCredits = async (...args) => { enter(); await held; return reserve(...args); };
    const opening = createSpeechRelaySession(identity, "consent", p.value); void opening.catch(() => {}); await entered;
    const closing = p.handle.close(); finish(); await opening.catch(() => {}); await closing;
    expect(p.handle.evidence()).toMatchObject({ stt: "not_dispatched", tts: "not_dispatched", accounting: "settled_actual", moneyTerminal: true, quotaRelease: "unknown" });
    const next = await store.checkAndRecord(identity, 1, p.value.usageLimits); expect(next.allowed).toBe(releaseCommitted);
    await p.handle.retryRetirement(); expect(releases).toBe(1); expect(p.money).toBe(2);
    expect((await store.checkAndRecord(identity, 1, p.value.usageLimits)).allowed).toBe(false);
  });
}
