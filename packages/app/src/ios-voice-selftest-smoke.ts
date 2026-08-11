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
} from "@elizaos/ui/voice";
import { evaluateVoiceSelfTestReport } from "../scripts/ios-voice-selftest-lib.mjs";
import {
  IOS_VOICE_SELFTEST_LOCAL_ACTIVE_SERVER,
  IOS_VOICE_SELFTEST_REQUEST_KEY,
  IOS_VOICE_SELFTEST_RESULT_KEY,
  type IosVoiceSelfTestRequest,
  parseIosVoiceSelfTestRequest,
} from "./ios-voice-selftest-boot";

const IOS_ONBOARDING_SMOKE_RESULT_KEY = "eliza:ios-onboarding-smoke:result";
const IOS_VOICE_SELFTEST_ONBOARDING_WAIT_MS = 180_000;
const IOS_VOICE_SELFTEST_RUN_TIMEOUT_MS = 240_000;
const IOS_LOCAL_VOICE_READINESS_DELAY_MS = 1_000;
const IOS_LOCAL_VOICE_RUN_RESERVE_MS = 15_000;
const DEFAULT_IOS_VOICE_SELFTEST_API_BASE = "http://127.0.0.1:31338";

interface RunIosVoiceSelfTestOptions {
  isIOS: boolean;
  client: ElizaClient;
  getPreference: (key: string) => Promise<string | null>;
  removePreference: (key: string) => Promise<void>;
  writeResult: (key: string, result: Record<string, unknown>) => Promise<void>;
  readStorageSnapshot: () => Record<string, string | null>;
  localReadiness?: { maxAttempts?: number; delayMs?: number };
}

let iosVoiceSelfTestStarted = false;

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

function assertLocalVoiceTransportState(
  request: IosVoiceSelfTestRequest,
  client: ElizaClient,
  readStorageSnapshot: RunIosVoiceSelfTestOptions["readStorageSnapshot"],
): void {
  const snapshot = readStorageSnapshot();
  const expectedServer = JSON.stringify(IOS_VOICE_SELFTEST_LOCAL_ACTIVE_SERVER);
  if (request.apiBase !== "eliza-local-agent://ipc") {
    throw new Error(
      `local voice request has unexpected base ${request.apiBase}`,
    );
  }
  if (client.getBaseUrl() !== request.apiBase) {
    throw new Error(
      `local voice client base ${client.getBaseUrl() || "<empty>"} != ${request.apiBase}`,
    );
  }
  if (snapshot["eliza:mobile-runtime-mode"] !== "local") {
    throw new Error(
      "local voice runtime mode was not authoritative before run",
    );
  }
  if (snapshot["eliza:first-run-complete"] !== "1") {
    throw new Error(
      "local voice first-run completion was not authoritative before run",
    );
  }
  if (snapshot["elizaos:active-server"] !== expectedServer) {
    throw new Error(
      "local voice active-server record was not canonical before run",
    );
  }
}

export async function waitForIosLocalVoiceReadiness(
  client: ElizaClient,
  {
    deadlineMs,
    maxAttempts = Number.POSITIVE_INFINITY,
    delayMs = IOS_LOCAL_VOICE_READINESS_DELAY_MS,
  }: { deadlineMs: number; maxAttempts?: number; delayMs?: number },
): Promise<void> {
  let lastDiagnostic: Record<string, unknown> = {};
  let attempt = 0;
  while (Date.now() < deadlineMs && attempt < maxAttempts) {
    attempt += 1;
    const [statusResult, asrResult] = await Promise.allSettled([
      client.getStatus(),
      client.fetch<{ ready?: unknown; provider?: unknown }>(
        "/api/asr/local-inference/status",
      ),
    ]);
    const status =
      statusResult.status === "fulfilled" ? statusResult.value : null;
    const asr = asrResult.status === "fulfilled" ? asrResult.value : null;
    const statusError =
      statusResult.status === "rejected"
        ? statusResult.reason instanceof Error
          ? statusResult.reason.message
          : String(statusResult.reason)
        : null;
    const asrError =
      asrResult.status === "rejected"
        ? asrResult.reason instanceof Error
          ? asrResult.reason.message
          : String(asrResult.reason)
        : null;
    const model = status?.model?.trim() ?? "";
    const agentReady =
      status?.canRespond === true ||
      (status?.canRespond === undefined &&
        status?.state === "running" &&
        model.length > 0);
    const asrReady = asr?.ready === true && asr.provider === "local-inference";
    lastDiagnostic = {
      attempt,
      agent: status
        ? {
            state: status.state,
            canRespond: status.canRespond,
            model: model || null,
          }
        : null,
      asr,
      statusError,
      asrError,
    };
    if (agentReady && asrReady) return;
    if (Date.now() < deadlineMs && attempt < maxAttempts) {
      await sleep(delayMs);
    }
  }
  throw new Error(
    `local voice runtime did not become ready: ${JSON.stringify(lastDiagnostic)}`,
  );
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
  localReadiness,
}: RunIosVoiceSelfTestOptions): Promise<boolean> {
  if (!isIOS || iosVoiceSelfTestStarted) return iosVoiceSelfTestStarted;
  const rawRequest = await readSmokePreference(
    IOS_VOICE_SELFTEST_REQUEST_KEY,
    getPreference,
  );
  if (!rawRequest) return false;

  iosVoiceSelfTestStarted = true;
  let request: IosVoiceSelfTestRequest = {
    mode: "remote",
    apiBase: DEFAULT_IOS_VOICE_SELFTEST_API_BASE,
    runId: "unparsed",
    requestedAt: null,
    deadlineAt: null,
  };
  let audioCtx: AudioContext | null = null;
  try {
    request = parseIosVoiceSelfTestRequest(rawRequest);
    await writeResult(IOS_VOICE_SELFTEST_RESULT_KEY, {
      ok: false,
      phase: "running",
      startedAt: new Date().toISOString(),
      mode: request.mode,
      apiBase: request.apiBase,
      runId: request.runId,
      requestedAt: request.requestedAt,
      deadlineAt: request.deadlineAt,
    });

    if (request.mode === "remote") {
      await waitForOnboardingSmokeResultIfPresent(getPreference);
    } else {
      assertLocalVoiceTransportState(request, client, readStorageSnapshot);
      const deadlineAtMs = Date.parse(request.deadlineAt ?? "");
      await waitForIosLocalVoiceReadiness(client, {
        ...localReadiness,
        deadlineMs:
          deadlineAtMs -
          IOS_VOICE_SELFTEST_RUN_TIMEOUT_MS -
          IOS_LOCAL_VOICE_RUN_RESERVE_MS,
      });
    }

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

    const requestDeadlineMs = request.deadlineAt
      ? Date.parse(request.deadlineAt)
      : Number.POSITIVE_INFINITY;
    const remainingRunMs = Math.min(
      IOS_VOICE_SELFTEST_RUN_TIMEOUT_MS,
      requestDeadlineMs - Date.now(),
    );
    if (!(remainingRunMs > 0)) {
      throw new Error("voice self-test request deadline expired before run");
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
      remainingRunMs,
    );

    const verdict = evaluateVoiceSelfTestReport(report, {
      requireLocalInference: request.mode === "local",
    });
    await writeResult(IOS_VOICE_SELFTEST_RESULT_KEY, {
      ok: verdict.pass,
      phase: verdict.pass ? "complete" : "failed",
      finishedAt: new Date().toISOString(),
      mode: request.mode,
      apiBase: request.apiBase,
      runId: request.runId,
      requestedAt: request.requestedAt,
      deadlineAt: request.deadlineAt,
      overall: report.overall,
      transcript: report.transcript,
      reply: report.reply,
      sendBackend: report.sendBackend,
      stages: report.stages,
      reasons: verdict.reasons,
      report,
    });
  } catch (error) {
    // error-policy:J1 smoke boundary — the failure is written to the harness
    // result sink for the orchestrator to surface as a nonzero exit
    await writeResult(IOS_VOICE_SELFTEST_RESULT_KEY, {
      ok: false,
      phase: "failed",
      finishedAt: new Date().toISOString(),
      mode: request.mode,
      apiBase: request.apiBase,
      runId: request.runId,
      requestedAt: request.requestedAt,
      deadlineAt: request.deadlineAt,
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
