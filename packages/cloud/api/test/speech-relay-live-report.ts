/** Public diagnostics for the protected live test. Never forward its private log. */
import { readFileSync } from "node:fs";

const stages = new Set([
  "configuration",
  "health",
  "consent",
  "session",
  "websocket",
  "ready",
  "tts",
  "stt",
  "revocation",
]);
const codes = new Set([
  "SPEECH_CONFIGURATION_INVALID",
  "SPEECH_HTTP_UNAVAILABLE",
  "SPEECH_HTTP_JSON_INVALID",
  "SPEECH_RELEASE_MISMATCH",
  "SPEECH_MINT_INVALID",
  "SPEECH_SOCKET_ORIGIN_INVALID",
  "SPEECH_SOCKET_FAILED",
  "SPEECH_SOCKET_CLOSED",
  "SPEECH_AUDIO_ENVELOPE_INVALID",
  "SPEECH_AUDIO_CONTEXT_INVALID",
  "SPEECH_AUDIO_FORMAT_INVALID",
  "SPEECH_AUDIO_BOUND_EXCEEDED",
  "SPEECH_FRAME_INVALID",
  "SPEECH_PROVIDER_REFUSED",
  "SPEECH_REFUSED_UNAVAILABLE",
  "SPEECH_REFUSED_UNAUTHORIZED",
  "SPEECH_REFUSED_INSUFFICIENT_CREDITS",
  "SPEECH_PROVIDER_CONTRACT_INVALID",
  "SPEECH_READY_TIMEOUT",
  "SPEECH_TTS_TIMEOUT",
  "SPEECH_NOT_INCREMENTAL",
  "SPEECH_STT_FINAL_TIMEOUT",
  "SPEECH_REVOKE_TIMEOUT",
]);
/** Staging Server-Timing span names (the client diagnostics allowlist) mapped to report fields. */
const SERVER_SPANS = {
  consent: {
    speech_identity_rate: "consentAuthMs",
    speech_consent_write: "consentStoreMs",
  },
  session: {
    speech_identity_rate: "sessionAuthMs",
    speech_consent_consume: "sessionConsumeMs",
    speech_directory_write: "sessionRelayInitMs",
  },
} as const;
/** Relay `timings` frame fields mapped to public numeric report fields. */
const RELAY_PHASES = {
  claimMs: "relayClaimMs",
  revocationMs: "relayRevocationMs",
  admissionMs: "relayAdmissionMs",
  relayMs: "relaySessionMs",
  activateMs: "relayActivateMs",
  openMs: "relayOpenMs",
} as const;
const SERVER_TIMING_FIELDS = [
  ...Object.values(SERVER_SPANS.consent),
  ...Object.values(SERVER_SPANS.session),
  ...Object.values(RELAY_PHASES),
] as const;

/** Keep only known, finite, nonnegative Server-Timing durations. */
export function speechServerTimings(
  route: keyof typeof SERVER_SPANS,
  header: string | null,
): Record<string, number> {
  const names: Record<string, string> = SERVER_SPANS[route];
  const out: Record<string, number> = {};
  for (const entry of (header ?? "").split(",")) {
    const [name, ...params] = entry.trim().split(";");
    const field = name ? names[name] : undefined;
    if (!field || !Object.hasOwn(names, name)) continue;
    for (const param of params) {
      const match = /^\s*dur=([0-9]+(?:\.[0-9]+)?)\s*$/.exec(param);
      if (match) out[field] = Math.round(Number(match[1]));
    }
  }
  return out;
}

/** Keep only known, finite, nonnegative relay bootstrap phases. */
export function speechRelayPhases(frame: Record<string, unknown>) {
  const out: Record<string, number> = {};
  for (const [phase, field] of Object.entries(RELAY_PHASES)) {
    const value = frame[phase];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      out[field] = Math.round(value);
  }
  return out;
}

const timings = [
  "consentMs",
  "sessionMs",
  "wsReadyMs",
  "bootstrapMs",
  "ttsStartupMs",
  "firstPcmMs",
  "ttsCompleteMs",
  "sttFinalMs",
  // Final arrival minus end of paced speech replay, before added silence begins.
  // Omitted when the final arrives before the replayed speech input ends.
  "sttTailMs",
  "revokeMs",
  "pcmFrames",
  "pcmBytes",
  // WebSocket 101 handshake, before hello. Separates socket routing from bootstrap.
  "wsOpenMs",
  // Staging server spans (Server-Timing and the opt-in relay timings frame).
  ...SERVER_TIMING_FIELDS,
] as const;

/** The relay exposes only these refusal enums, never provider error text. */
export function speechRelayRefusal(code: unknown, reason?: unknown): string {
  if (code === "unauthorized") return "SPEECH_REFUSED_UNAUTHORIZED";
  if (code === "unavailable")
    return reason === "insufficient_credits"
      ? "SPEECH_REFUSED_INSUFFICIENT_CREDITS"
      : "SPEECH_REFUSED_UNAVAILABLE";
  return "SPEECH_PROVIDER_REFUSED";
}

function safeCode(value: unknown): string {
  return typeof value === "string" &&
    (codes.has(value) || /^SPEECH_HTTP_STATUS_[45][0-9]{2}$/.test(value))
    ? value
    : "SPEECH_CONTRACT_FAILED";
}

export function speechRelayFailure(stage: string, error: unknown) {
  return {
    phase: "speech-relay-live",
    status: "failed",
    stage: stages.has(stage) ? stage : "unknown",
    code: safeCode(error instanceof Error ? error.message : undefined),
  };
}

/** Keep the test failed without publishing the original error or its cause. */
export function reportedSpeechRelayTest(
  run: (stage: (value: string) => void) => Promise<void>,
  report: (line: string) => void = console.info,
): () => Promise<void> {
  return async () => {
    let stage = "configuration";
    try {
      await run((value) => {
        stage = value;
      });
    } catch (error) {
      const failure = speechRelayFailure(stage, error);
      report(JSON.stringify(failure));
      throw new Error(failure.code);
    }
  };
}

/** Parse only structured reports and rebuild each public record from allowed fields. */
export function publicSpeechRelayReports(log: string, failed: boolean): string {
  const reports: Record<string, string | number>[] = [];
  for (const line of log.split("\n")) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.phase !== "speech-relay-live") continue;
    if (failed && record.status === "failed") {
      reports.push(
        speechRelayFailure(
          typeof record.stage === "string" ? record.stage : "unknown",
          new Error(safeCode(record.code)),
        ),
      );
    } else if (!failed && record.status === "passed") {
      const report: Record<string, string | number> = {
        phase: "speech-relay-live",
        status: "passed",
      };
      for (const key of timings) {
        const number = record[key];
        if (
          typeof number === "number" &&
          Number.isFinite(number) &&
          number >= 0
        )
          report[key] = number;
      }
      reports.push(report);
    }
  }
  if (failed && !reports.length)
    reports.push(speechRelayFailure("unknown", undefined));
  return reports.map((report) => JSON.stringify(report)).join("\n");
}

if (import.meta.main) {
  const [file, result] = process.argv.slice(2);
  if (!file || !/^[0-9]+$/.test(result ?? ""))
    throw new Error("Supply the private log path and test exit code");
  const report = publicSpeechRelayReports(
    readFileSync(file, "utf8"),
    result !== "0",
  );
  if (report) process.stdout.write(`${report}\n`);
}
