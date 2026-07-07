/**
 * On-device iOS voice round-trip smoke, run inside the shipped app (not a unit
 * test) when the CI/QA harness stages a request in localStorage/Preferences
 * (`eliza:ios-voice-selftest:request`). `runIosVoiceSelfTestSmokeIfRequested()`
 * waits for any pending onboarding smoke, then drives the SAME production
 * {@link runVoiceSelfTest} harness the chat composer/voice pill use — a real
 * bundled speech clip ("what time is it") -> real on-device/local ASR -> real
 * agent reply over SSE -> real TTS decode+playback — against the paired agent
 * `client` points at. It writes the full machine-readable report (overall,
 * per-stage asr/send/tts status, transcript, reply) to Preferences
 * (`…:result`) for the simulator orchestrator to poll, computing `ok` with the
 * same no-false-green rule as `voice-selftest.android.spec.ts`: a `skipped`
 * stage (e.g. local ASR not provisioned) is NOT a pass. Runs at most once per
 * app launch. WKWebView has no CDP, so this Preferences handshake is how the
 * host orchestrator reads the verdict back.
 */

import type { ElizaClient } from "@elizaos/ui/api";
import { shellLocalStorage } from "@elizaos/ui/bridge";
import {
  EXPECTED_PHRASE,
  KNOWN_PHRASE_WAV_DATA_URL,
  runVoiceSelfTest,
  type VoiceSelfTestReport,
} from "@elizaos/ui/voice";

const IOS_VOICE_SELFTEST_REQUEST_KEY = "eliza:ios-voice-selftest:request";
const IOS_VOICE_SELFTEST_RESULT_KEY = "eliza:ios-voice-selftest:result";
const IOS_ONBOARDING_SMOKE_RESULT_KEY = "eliza:ios-onboarding-smoke:result";
const IOS_VOICE_SELFTEST_ONBOARDING_WAIT_MS = 180_000;
const IOS_VOICE_SELFTEST_RUN_TIMEOUT_MS = 240_000;
const DEFAULT_IOS_VOICE_SELFTEST_API_BASE = "http://127.0.0.1:31338";

/** The three stages every real voice round-trip must clear. */
const REQUIRED_VOICE_STAGES: ReadonlyArray<"asr" | "send" | "tts"> = [
  "asr",
  "send",
  "tts",
];

interface IosVoiceSelfTestRequest {
  apiBase: string;
}

interface RunIosVoiceSelfTestOptions {
  isIOS: boolean;
  client: ElizaClient;
  getPreference: (key: string) => Promise<string | null>;
  removePreference: (key: string) => Promise<void>;
  writeResult: (key: string, result: Record<string, unknown>) => Promise<void>;
  readStorageSnapshot: () => Record<string, string | null>;
}

let iosVoiceSelfTestStarted = false;

function parseIosVoiceSelfTestRequest(
  raw: string | null,
): IosVoiceSelfTestRequest {
  const fallback = { apiBase: DEFAULT_IOS_VOICE_SELFTEST_API_BASE };
  if (!raw || raw === "1") return fallback;
  try {
    const parsed = JSON.parse(raw) as { apiBase?: unknown };
    return {
      apiBase:
        typeof parsed.apiBase === "string" && parsed.apiBase.trim()
          ? parsed.apiBase.trim()
          : fallback.apiBase,
    };
  } catch (error) {
    // error-policy:J3 corrupt smoke-request blob — fail the harness instead of
    // turning malformed input into a false-green default run
    throw new Error(
      `Invalid iOS voice self-test request: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// Older WebKit exposes the constructor under a vendor prefix; read it through a
// widened view of the global rather than an `as unknown as` double cast.
interface WebkitAudioWindow {
  webkitAudioContext?: typeof AudioContext;
}

function getAudioCtx(): AudioContext {
  const webkitCtor = (window as Window & WebkitAudioWindow).webkitAudioContext;
  const Ctor = window.AudioContext ?? webkitCtor;
  if (!Ctor) throw new Error("AudioContext unavailable in this WebView");
  return new Ctor();
}

async function readSmokePreference(
  key: string,
  getPreference: RunIosVoiceSelfTestOptions["getPreference"],
): Promise<string | null> {
  const preferenceValue = await getPreference(key);
  if (preferenceValue) return preferenceValue;
  try {
    const value = window.localStorage.getItem(key);
    if (value) return value;
  } catch (error) {
    // error-policy:J4 unavailable localStorage — Preferences (read above) is
    // the authoritative native store for the simulator harness
    console.warn(
      "[ios-voice-selftest] localStorage read failed; using Preferences only",
      error,
    );
  }
  return null;
}

/**
 * Block until any onboarding smoke that armed this launch has connected the app
 * to its host agent, so `client` points at a running backend before the voice
 * round-trip fires. Mirrors the attachment smoke's ordering guard.
 */
async function waitForOnboardingSmokeResultIfPresent(
  getPreference: RunIosVoiceSelfTestOptions["getPreference"],
): Promise<void> {
  const initial = await readSmokePreference(
    IOS_ONBOARDING_SMOKE_RESULT_KEY,
    getPreference,
  );
  if (!initial) {
    await sleep(750);
    return;
  }

  const deadline = Date.now() + IOS_VOICE_SELFTEST_ONBOARDING_WAIT_MS;
  let lastRaw = initial;
  while (Date.now() < deadline) {
    const raw =
      (await readSmokePreference(
        IOS_ONBOARDING_SMOKE_RESULT_KEY,
        getPreference,
      )) ?? lastRaw;
    lastRaw = raw;
    try {
      const parsed = JSON.parse(raw) as {
        ok?: unknown;
        phase?: unknown;
        error?: unknown;
      };
      if (parsed.ok === true || parsed.phase === "complete") return;
      if (parsed.phase === "failed" || parsed.error) {
        throw new Error(
          `iOS onboarding smoke failed before voice self-test: ${raw}`,
        );
      }
    } catch (error) {
      // error-policy:J3 corrupt interim result blob — keep polling; a parsed
      // "failed" result still propagates
      if (error instanceof Error && error.message.includes("failed")) {
        throw error;
      }
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for iOS onboarding smoke before voice self-test. Last result: ${lastRaw}`,
  );
}

/**
 * Apply the Android-parity verdict to a report: overall must be `pass` and every
 * required stage must be `pass` (a `skipped` stage fails). Returns the reasons a
 * report is not green so the harness result carries them for triage.
 */
function verdictReasons(report: VoiceSelfTestReport): string[] {
  const reasons: string[] = [];
  if (report.overall !== "pass") {
    reasons.push(`overall is "${report.overall}", expected "pass"`);
  }
  const byStage = new Map(report.stages.map((s) => [s.stage, s.status]));
  for (const name of REQUIRED_VOICE_STAGES) {
    const status = byStage.get(name);
    if (status === undefined) {
      reasons.push(`stage "${name}" is missing`);
    } else if (status !== "pass") {
      reasons.push(`stage "${name}" is "${status}", expected "pass"`);
    }
  }
  if (!report.transcript.toLowerCase().includes("time")) {
    reasons.push(`transcript does not contain "time"`);
  }
  if (report.reply.trim().length === 0) {
    reasons.push("agent reply is empty");
  }
  return reasons;
}

async function withRunTimeout<T>(
  label: string,
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeoutId: number | null = null;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  }
}

export async function runIosVoiceSelfTestSmokeIfRequested({
  isIOS,
  client,
  getPreference,
  removePreference,
  writeResult,
  readStorageSnapshot,
}: RunIosVoiceSelfTestOptions): Promise<boolean> {
  if (!isIOS || iosVoiceSelfTestStarted) return iosVoiceSelfTestStarted;
  let rawRequest: string | null = null;
  try {
    rawRequest = window.localStorage.getItem(IOS_VOICE_SELFTEST_REQUEST_KEY);
  } catch {
    // error-policy:J3 unavailable storage reads as "no request"; the
    // Preferences read below still serves the simulator harness
    rawRequest = null;
  }
  if (!rawRequest) {
    rawRequest = await getPreference(IOS_VOICE_SELFTEST_REQUEST_KEY);
  }
  if (!rawRequest) return false;

  iosVoiceSelfTestStarted = true;
  let request: IosVoiceSelfTestRequest = {
    apiBase: DEFAULT_IOS_VOICE_SELFTEST_API_BASE,
  };
  let audioCtx: AudioContext | null = null;
  try {
    request = parseIosVoiceSelfTestRequest(rawRequest);
    await writeResult(IOS_VOICE_SELFTEST_RESULT_KEY, {
      ok: false,
      phase: "running",
      startedAt: new Date().toISOString(),
      apiBase: request.apiBase,
    });

    await waitForOnboardingSmokeResultIfPresent(getPreference);

    audioCtx = getAudioCtx();
    if (audioCtx.state === "suspended") {
      // error-policy:J5 a WKWebView AudioContext boots suspended without a user
      // gesture; the TTS stage records started/outputObserved from the decoded
      // buffer either way, so a failed resume here must not abort the run
      await audioCtx.resume().catch((error) => {
        console.warn(
          "[ios-voice-selftest] AudioContext resume failed; continuing with decoded-buffer TTS evidence",
          error,
        );
      });
    }

    const report = await withRunTimeout(
      "voice self-test",
      runVoiceSelfTest({
        platform: "ios",
        mode: "wav-direct",
        fixtureUrl: KNOWN_PHRASE_WAV_DATA_URL,
        expectedPhrase: EXPECTED_PHRASE,
        // iOS local/remote runtime rides the on-device fused omnivoice TTS, the
        // same route the Android/desktop lanes exercise.
        ttsRoute: "/api/tts/local-inference",
        client,
        audioCtx,
      }),
      IOS_VOICE_SELFTEST_RUN_TIMEOUT_MS,
    );

    const reasons = verdictReasons(report);
    await writeResult(IOS_VOICE_SELFTEST_RESULT_KEY, {
      ok: reasons.length === 0,
      phase: reasons.length === 0 ? "complete" : "failed",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      overall: report.overall,
      transcript: report.transcript,
      reply: report.reply,
      sendBackend: report.sendBackend,
      stages: report.stages,
      reasons,
      report,
    });
  } catch (error) {
    // error-policy:J1 smoke boundary — the failure is written to the harness
    // result sink for the orchestrator to surface as a nonzero exit
    await writeResult(IOS_VOICE_SELFTEST_RESULT_KEY, {
      ok: false,
      phase: "failed",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      error: error instanceof Error ? error.message : String(error),
      storage: readStorageSnapshot(),
    });
  } finally {
    if (audioCtx) {
      // error-policy:J6 best-effort teardown — the run is complete
      await audioCtx.close().catch((error) => {
        console.warn(
          "[ios-voice-selftest] AudioContext teardown failed after completed run",
          error,
        );
      });
    }
    try {
      shellLocalStorage.removeItem(IOS_VOICE_SELFTEST_REQUEST_KEY);
    } catch (error) {
      // error-policy:J6 best-effort cleanup — Preferences removal below is
      // authoritative for the simulator harness
      console.warn(
        "[ios-voice-selftest] localStorage cleanup failed; removing Preferences request",
        error,
      );
    }
    await removePreference(IOS_VOICE_SELFTEST_REQUEST_KEY);
  }
  return true;
}
