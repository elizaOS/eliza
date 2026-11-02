import { expect, test } from "bun:test";
import { initializeSpeechRecord, claimSpeechOpening, markSpeechOwned, beginSpeechRetirement, recordSpeechSettlement, completeSpeechRetirement, type SpeechLifecycleRecord } from "./speech-retirement-state";
const input = (): SpeechLifecycleRecord => ({ sessionId: "session", tokenDigest: "digest", expiresAt: 60000, caller: { user: { id: "owner", organization_id: "org" } }, proofVersion: 1, phase: "minted" });
const init = () => initializeSpeechRecord(undefined, input(), 0);
const current = () => claimSpeechOpening(init(), "claim");
const actual = (value: SpeechLifecycleRecord, kind: "stt" | "tts") => recordSpeechSettlement(value, kind, { state: "settled_actual", requestId: `speech:session:${kind}`, amountUsd: "0.01" });
test.each(["starting", "retiring", "closed"] as const)("duplicate initialization never resets %s", phase => {
  const old = { ...current(), phase };
  expect(initializeSpeechRecord(old, input(), 1000)).toBe(old);
});
test.each(["sessionId", "tokenDigest", "expiresAt", "proofVersion"])("rejects changed immutable %s", key => {
  expect(() => initializeSpeechRecord(init(), { ...input(), [key]: "changed" } as never, 1)).toThrow();
});
test("late owned completion cannot overwrite revoke generation", () => {
  const opening = current(); const retiring = beginSpeechRetirement(opening);
  expect(markSpeechOwned(retiring, "claim", opening.retirement!.generation)).toBeNull();
  expect(() => claimSpeechOpening(retiring, "another")).toThrow();
});
test("concurrent revoke joins generation and attempt", () => {
  const retiring = beginSpeechRetirement(current());
  expect(beginSpeechRetirement(retiring)).toBe(retiring);
});
test("restored active without evidence is unconfirmed", () => {
  const owned = markSpeechOwned(current(), "claim", 1)!;
  const retiring = beginSpeechRetirement(owned);
  const done = completeSpeechRetirement(retiring, retiring.retirement!, undefined, 2);
  expect(done.retirement!.proof!.state).toBe("unconfirmed");
});
test("confirmed proof persists and initialization/revoke replay does not alter it", () => {
  let value = beginSpeechRetirement(current()); value = actual(actual(value, "stt"), "tts");
  const done = completeSpeechRetirement(value, value.retirement!, { stt: "gracefully_drained", tts: "transport_closed", accounting: "settled_actual" }, 2);
  expect(done.retirement!.proof!.state).toBe("confirmed");
  expect(beginSpeechRetirement(done)).toBe(done);
  expect(initializeSpeechRecord(done, input(), 900)).toBe(done);
});
test("conservative settlement never becomes actual or confirmed", () => {
  let value = beginSpeechRetirement(current());
  value = recordSpeechSettlement(value, "stt", { state: "settled_conservative", requestId: "speech:session:stt", amountUsd: "1" });
  expect(() => actual(value, "stt")).toThrow();
  expect(completeSpeechRetirement(value, value.retirement!, { stt: "unknown", tts: "transport_closed", accounting: "unknown" }, 3).retirement!.proof!.state).toBe("unconfirmed");
});
test("valid never-started closes admission with no reservation", () => {
  const value = beginSpeechRetirement(init());
  expect(completeSpeechRetirement(value, value.retirement!, undefined, 1).retirement!.proof).toMatchObject({ state: "confirmed", mode: "never_started" });
});
test.each(["id", "organization_id"])("initializer cannot change caller %s", key => {
  const changed = input(); changed.caller.user = { ...changed.caller.user, [key]: "other" };
  expect(() => initializeSpeechRecord(init(), changed, 1)).toThrow();
});
test("completed failed attempt gets a new token while pending joins keep theirs", () => {
  const first = beginSpeechRetirement(current());
  expect(beginSpeechRetirement(first)).toBe(first);
  const retry = beginSpeechRetirement(first, true);
  expect(retry.retirement!.generation).toBeGreaterThan(first.retirement!.generation);
  expect(retry.retirement!.attempt).toBeGreaterThan(first.retirement!.attempt);
  expect(() => completeSpeechRetirement(retry, first.retirement!, undefined, 3)).toThrow("generation changed");
});

test("live opening completion can confirm no dispatch but recreation cannot", () => {
  const opening = current(); const retiring = beginSpeechRetirement(opening);
  const evidence = { stt: "not_dispatched", tts: "not_dispatched", accounting: "not_started" } as const;
  expect(completeSpeechRetirement(retiring, retiring.retirement!, evidence, 1).retirement!.proof!.state).toBe("unconfirmed");
  const live = { claim: "claim", generation: opening.retirement!.openingGeneration!, settled: true } as const;
  expect(completeSpeechRetirement(retiring, retiring.retirement!, evidence, 1, true, live).retirement!.proof).toMatchObject({ state: "confirmed", mode: "not_dispatched" });
  expect(completeSpeechRetirement(retiring, retiring.retirement!, evidence, 1, true, { ...live, claim: "wrong" }).retirement!.proof!.state).toBe("unconfirmed");
});
