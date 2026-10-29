/**
 * The end-of-turn chain a voice conversation asks after the short silence gap
 * (`@elizaos/voice/endpoint-chain`):
 *
 *  1. `local`: the resident's fused end-of-turn scorer ({@link residentEndpoint}). A scored
 *     `finished` or `continue` decides; nothing else is asked.
 *  2. `clef` (optional): Eliza Cloud's Clef `turn` decision, asked only when the local scorer
 *     could not score (unavailable or failed). It sends the transcript text only (never audio),
 *     has its own timeout, and an unavailable Clef (HTTP 503, disabled, provider error, timeout,
 *     refused request) is never a yes. The stage exists only when the host enables it explicitly
 *     AND supplies a Cloud client; either alone leaves it out.
 *  3. The long silence gap: owned by {@link VoiceAssistantSession}. When no stage decides, the
 *     chain answers `unavailable` and the gap submits the turn.
 *
 * Every answer names the stage that produced it (`path: "local" | "clef"`), so diagnostics can
 * say which path ended the turn; a gap submission is the session's `by: "gap"`. Resumed speech
 * aborts the signal the session passed: the chain stops between stages, never asks Clef after an
 * abort, and rejects, so a pending submit is cancelled.
 *
 * Pure module (no DOM, storage, logging or Cloud SDK import): the host supplies the ports. The
 * Clef client shape matches `createClefDecisionsClient` from `@elizaos/cloud-sdk`.
 */
import type {
  EndpointDecision,
  EndpointResult,
} from "./voice-assistant-session.js";

/** Which chain stage produced an endpoint answer. */
export type EndpointPath = "local" | "clef";
/** Why the Clef stage gave no verdict. */
export type ClefEndpointUnavailableReason =
  | "clef-disabled"
  | "clef-unavailable"
  | "clef-timeout"
  | "clef-error"
  | "clef-too-long";
export const CLEF_ENDPOINT_UNAVAILABLE_REASONS: readonly ClefEndpointUnavailableReason[] =
  [
    "clef-disabled",
    "clef-unavailable",
    "clef-timeout",
    "clef-error",
    "clef-too-long",
  ];
/** Clef's own transcript limit (`CLEF_DECISION_LIMITS.transcript`); longer text is never sent. */
export const CLEF_TURN_MAX_CHARS = 2_000;
/** Default Clef stage budget. It must fit inside the session's endpoint deadline. */
export const CLEF_ENDPOINT_TIMEOUT_MS = 300;
/** A Clef turn is complete at this probability or above (`CLEF_TURN_COMPLETE_THRESHOLD`). */
const CLEF_COMPLETE_THRESHOLD = 0.5;

export type EndpointPort = (
  text: string,
  signal: AbortSignal,
) => Promise<EndpointDecision | EndpointResult>;
export interface ClefTurnRequest {
  kind: "turn";
  transcript: string;
  recentTurns?: { speaker: "person" | "assistant"; text: string }[];
}
/** `createClefDecisionsClient(...)` from `@elizaos/cloud-sdk`, or any client of the same shape. */
export type ClefTurnClient = (
  request: ClefTurnRequest,
  signal?: AbortSignal,
) => Promise<unknown>;
export interface ClefEndpointStage {
  /** The explicit switch. Anything but `true` leaves the stage out. */
  enabled: boolean;
  /** The Cloud client. Without one the stage is left out. */
  client: ClefTurnClient | null | undefined;
  timeoutMs?: number;
  /** Recent turns for context, oldest first (at most 6 are sent). Text only. */
  recentTurns?(): ClefTurnRequest["recentTurns"];
}
export interface EndpointChainOptions {
  local?: EndpointPort | null;
  clef?: ClefEndpointStage | null;
  /** Clock for latency and the Clef timeout (tests). */
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}
/** An endpoint answer that names the stage that produced it. */
export type ChainedEndpointResult = EndpointResult & { path: EndpointPath };

const isAbort = (error: unknown, signal: AbortSignal) =>
  signal.aborted ||
  (error instanceof Error && error.name === "AbortError") ||
  (typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError");

/** Whether the Clef stage would be built from these options. */
export function clefEndpointStageEnabled(
  stage: ClefEndpointStage | null | undefined,
): boolean {
  return stage?.enabled === true && typeof stage.client === "function";
}

/**
 * Reads one Clef `turn` response. Only `status: "ok"`, `kind: "turn"` and a boolean `complete`
 * (with a probability that agrees with it, when given) is a verdict; everything else is
 * unavailable, never a yes.
 */
export function readClefTurn(
  value: unknown,
): EndpointResult & { decision: EndpointDecision } {
  const row =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (row?.status === "unavailable")
    return {
      decision: "unavailable",
      reason: row.reason === "disabled" ? "clef-disabled" : "clef-unavailable",
    };
  if (
    !row ||
    row.status !== "ok" ||
    row.kind !== "turn" ||
    typeof row.complete !== "boolean"
  )
    return { decision: "unavailable", reason: "clef-unavailable" };
  const probability = row.completeProbability;
  if (
    probability !== undefined &&
    (typeof probability !== "number" ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1 ||
      probability >= CLEF_COMPLETE_THRESHOLD !== row.complete)
  )
    return { decision: "unavailable", reason: "clef-unavailable" };
  return { decision: row.complete ? "finished" : "continue" };
}

/**
 * Builds the endpoint port for {@link VoiceAssistantSession}. Returns `undefined` when no stage is
 * configured, so the session's long gap decides alone (`semantic: "not-asked"`).
 */
export function createEndpointChain(
  options: EndpointChainOptions,
):
  | ((text: string, signal: AbortSignal) => Promise<ChainedEndpointResult>)
  | undefined {
  const local = typeof options.local === "function" ? options.local : null;
  const clefStage = clefEndpointStageEnabled(options.clef)
    ? (options.clef as ClefEndpointStage & { client: ClefTurnClient })
    : null;
  if (!local && !clefStage) return undefined;
  const now =
    options.now ??
    (() =>
      typeof performance !== "undefined" &&
      typeof performance.now === "function"
        ? performance.now()
        : Date.now());
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));

  const askLocal = async (
    text: string,
    signal: AbortSignal,
  ): Promise<ChainedEndpointResult> => {
    try {
      const value = await (local as EndpointPort)(text, signal);
      signal.throwIfAborted();
      const result: EndpointResult =
        typeof value === "string"
          ? { decision: value }
          : (value ?? { decision: "unavailable" });
      return { ...result, path: "local" };
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      // A failing scorer is not a verdict; without a later stage the session counts it as an error.
      if (!clefStage) throw error;
      return { decision: "unavailable", reason: "unknown", path: "local" };
    }
  };

  const askClef = async (
    text: string,
    signal: AbortSignal,
  ): Promise<ChainedEndpointResult> => {
    const stage = clefStage as ClefEndpointStage & { client: ClefTurnClient };
    const transcript = text.replace(/\s+/g, " ").trim();
    if (!transcript)
      return { decision: "unavailable", reason: "clef-error", path: "clef" };
    if (transcript.length > CLEF_TURN_MAX_CHARS)
      return { decision: "unavailable", reason: "clef-too-long", path: "clef" };
    let recentTurns: ClefTurnRequest["recentTurns"];
    try {
      recentTurns = stage
        .recentTurns?.()
        ?.filter(
          (turn) =>
            (turn?.speaker === "person" || turn?.speaker === "assistant") &&
            typeof turn.text === "string" &&
            turn.text.trim().length > 0 &&
            turn.text.length <= CLEF_TURN_MAX_CHARS,
        )
        .slice(-6);
    } catch {
      recentTurns = undefined;
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    let timer: unknown;
    const expired = new Promise<ChainedEndpointResult>((resolve) => {
      timer = setTimer(
        () => {
          timedOut = true;
          controller.abort(new DOMException("Clef timed out", "TimeoutError"));
          resolve({
            decision: "unavailable",
            reason: "clef-timeout",
            path: "clef",
          });
        },
        Math.max(1, stage.timeoutMs ?? CLEF_ENDPOINT_TIMEOUT_MS),
      );
    });
    const askedAt = now();
    const asked = Promise.resolve()
      .then(() =>
        stage.client(
          {
            kind: "turn",
            transcript,
            ...(recentTurns?.length ? { recentTurns } : {}),
          },
          controller.signal,
        ),
      )
      .then(
        (value): ChainedEndpointResult => {
          const result = readClefTurn(value);
          return result.decision === "unavailable"
            ? { ...result, path: "clef" }
            : {
                ...result,
                latencyMs: Math.max(0, Math.round(now() - askedAt)),
                path: "clef",
              };
        },
        (error: unknown): ChainedEndpointResult => {
          if (signal.aborted) throw error;
          return {
            decision: "unavailable",
            reason: timedOut ? "clef-timeout" : "clef-error",
            path: "clef",
          };
        },
      );
    // The race may settle on the timeout first; a later rejection is then not unhandled.
    void asked.catch(() => {});
    try {
      const settled = await Promise.race([asked, expired]);
      signal.throwIfAborted();
      return settled;
    } finally {
      clearTimer(timer);
      signal.removeEventListener("abort", abort);
      controller.abort();
    }
  };

  return async (text, signal) => {
    signal.throwIfAborted();
    if (local) {
      const result = await askLocal(text, signal);
      if (result.decision !== "unavailable" || !clefStage) return result;
    }
    // Resumed speech between stages: never ask Clef for a superseded utterance.
    signal.throwIfAborted();
    return askClef(text, signal);
  };
}
