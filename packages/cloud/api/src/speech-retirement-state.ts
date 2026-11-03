/** Pure transitions used inside the coordinator's durable storage transaction. */
import type { SpeechRetirementEvidence, SpeechRetirementProof } from "@elizaos/host/voice/speech-relay-wire";
export type SettlementProgress = { state: "not_reserved" } | {
  state: "reserving" | "reserved" | "settling" | "unconfirmed" | "settled_actual" | "settled_conservative";
  requestId: string;
  amountUsd?: string;
  basis?: "submitted_counter_provider_unconfirmed";
};
export interface RetirementState {
  generation: number;
  attempt: number;
  retryDeadlineAt?: number;
  initializedAt: number;
  acquisition: "never_started" | "opening" | "owned";
  openingClaim?: string;
  openingGeneration?: number;
  progress: { stt: SettlementProgress; tts: SettlementProgress };
  proof?: SpeechRetirementProof;
}
export interface SpeechLifecycleRecord {
  sessionId: string;
  tokenDigest: string;
  expiresAt: number;
  caller: { user: { id: string; organization_id: string } };
  proofVersion?: 1;
  phase: "minted" | "starting" | "active" | "retiring" | "closed";
  retirement?: RetirementState;
  quotaRelease?: "not_required" | "released" | "unknown";
}
export function initializeSpeechRecord<T extends SpeechLifecycleRecord>(existing: T | undefined, input: T, now: number): T {
  if (existing) {
    if (existing.sessionId !== input.sessionId || existing.tokenDigest !== input.tokenDigest ||
        existing.expiresAt !== input.expiresAt || existing.proofVersion !== input.proofVersion ||
        existing.caller.user.id !== input.caller.user.id ||
        existing.caller.user.organization_id !== input.caller.user.organization_id)
      throw Error("Speech initialization identity mismatch");
    return existing;
  }
  return { ...input, phase: "minted", ...(input.proofVersion === 1 ? { retirement: {
    generation: 0, attempt: 0, initializedAt: now, acquisition: "never_started",
    progress: { stt: { state: "not_reserved" }, tts: { state: "not_reserved" } },
  } } : {}) };
}
export function claimSpeechOpening<T extends SpeechLifecycleRecord>(record: T, claim: string): T {
  if (record.phase !== "minted") throw Error("Speech opening already claimed or retired");
  if (record.proofVersion !== 1) return { ...record, phase: "starting" };
  const state = record.retirement;
  if (!state || state.acquisition !== "never_started" || state.proof) throw Error("Invalid speech opening state");
  const generation = state.generation + 1;
  return { ...record, phase: "starting", retirement: { ...state, generation,
    acquisition: "opening", openingClaim: claim, openingGeneration: generation } };
}
export function markSpeechOwned<T extends SpeechLifecycleRecord>(record: T, claim: string, generation?: number): T | null {
  if (record.phase !== "starting") return null;
  if (record.proofVersion !== 1) return { ...record, phase: "active" };
  const state = record.retirement;
  if (!state || state.generation !== generation || state.openingGeneration !== generation ||
      state.openingClaim !== claim || state.proof) return null;
  return { ...record, phase: "active", retirement: { ...state, acquisition: "owned" } };
}
export function beginSpeechRetirement<T extends SpeechLifecycleRecord>(record: T, retryCompletedAttempt = false): T {
  if ((record.proofVersion === 1 && record.retirement?.proof?.state === "confirmed") || (record.phase === "retiring" && !retryCompletedAttempt)) return record;
  if (!record.retirement) return { ...record, phase: "retiring" };
  return { ...record, phase: "retiring", retirement: { ...record.retirement,
    generation: record.retirement.generation + 1, attempt: record.retirement.attempt + 1 } };
}
export function recordSpeechSettlement<T extends SpeechLifecycleRecord>(record: T, kind: "stt" | "tts", progress: SettlementProgress): T {
  if (!record.retirement) return record;
  if (record.retirement.proof?.state === "confirmed") throw Error("Speech retirement is immutable");
  if (progress.state !== "not_reserved" && progress.requestId !== `speech:${record.sessionId}:${kind}`)
    throw Error("Speech settlement identity mismatch");
  const previous = record.retirement.progress[kind];
  if (previous.state === "settled_actual" || previous.state === "settled_conservative") {
    if ((progress.state === "settled_actual" || progress.state === "settled_conservative") &&
        (progress.state !== previous.state || progress.amountUsd !== previous.amountUsd || progress.basis !== previous.basis))
      throw Error("Speech settlement outcome changed");
    return record;
  }
  return { ...record, retirement: { ...record.retirement,
    progress: { ...record.retirement.progress, [kind]: progress } } };
}
export interface LiveSpeechOpeningCompletion { claim: string; generation: number; settled: true }
export function completeSpeechRetirement<T extends SpeechLifecycleRecord>(record: T, token: { generation?: number; attempt?: number }, evidence: SpeechRetirementEvidence | undefined, now: number, confirmedAllowed = true, liveOpening?: LiveSpeechOpeningCompletion): T {
  const state = record.retirement;
  // Unknown daily quota cannot substitute for independent terminal money.
  confirmedAllowed = confirmedAllowed && (evidence?.quotaRelease !== "unknown" || evidence.moneyTerminal === true);
  if (record.proofVersion === 1 && state?.proof?.state === "confirmed") return record;
  if (record.proofVersion !== 1 || !state) return { ...record, phase: "closed", ...(evidence?.quotaRelease ? { quotaRelease: evidence.quotaRelease } : {}) };
  if (record.phase !== "retiring" || state.generation !== token.generation || state.attempt !== token.attempt)
    throw Error("Speech retirement generation changed");
  const base = { version: 1 as const, sessionId: record.sessionId };
  const none = Object.values(state.progress).every(value => value.state === "not_reserved");
  const actual = Object.values(state.progress).every(value => value.state === "settled_actual");
  const liveOwner = liveOpening?.settled === true && liveOpening.claim === state.openingClaim &&
    liveOpening.generation === state.openingGeneration;
  const zeroReservations = Object.values(state.progress).every(value =>
    value.state === "not_reserved" || (value.state === "settled_actual" && value.amountUsd === "0"));
  const noProviderDispatch = evidence?.stt === "not_dispatched" && evidence.tts === "not_dispatched" &&
    (evidence.accounting === "not_started" || evidence.accounting === "settled_actual");
  let proof: SpeechRetirementProof;
  if (confirmedAllowed && state.acquisition === "never_started" && none && now >= state.initializedAt) {
    proof = { ...base, state: "confirmed", mode: "never_started", stt: "not_dispatched", tts: "not_dispatched", accounting: "not_started", completedAt: new Date(now).toISOString() };
  } else if (confirmedAllowed && liveOwner && noProviderDispatch && zeroReservations && now >= state.initializedAt) {
    const settledAny = Object.values(state.progress).some(value => value.state === "settled_actual");
    proof = { ...base, state: "confirmed", mode: "not_dispatched", stt: "not_dispatched", tts: "not_dispatched",
      accounting: settledAny ? "settled_actual" : "not_started", completedAt: new Date(now).toISOString() };
  } else if (confirmedAllowed && evidence && evidence.stt !== "unknown" && evidence.tts !== "unknown" &&
      evidence.accounting === "settled_actual" && actual && now >= state.initializedAt) {
    proof = { ...base, state: "confirmed", mode: "retired", stt: evidence.stt, tts: evidence.tts,
      accounting: "settled_actual", completedAt: new Date(now).toISOString() };
  } else {
    proof = { ...base, state: "unconfirmed", reason: !evidence ? "opening_unresolved" :
      evidence.stt === "unknown" || evidence.tts === "unknown" ? "provider_unconfirmed" :
      evidence.quotaRelease === "unknown" ? "quota_unconfirmed" : "accounting_unconfirmed" };
  }
  return { ...record, phase: "closed", ...(evidence?.quotaRelease ? { quotaRelease: evidence.quotaRelease } : {}), retirement: { ...state, proof } };
}
