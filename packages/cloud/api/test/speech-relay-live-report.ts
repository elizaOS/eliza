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
const timings = [
  "bootstrapMs",
  "firstPcmMs",
  "ttsCompleteMs",
  "sttFinalMs",
  "revokeMs",
  "pcmFrames",
  "pcmBytes",
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
