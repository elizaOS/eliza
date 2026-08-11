/**
 * Pure contracts for the iOS simulator voice round-trip lane. This module owns
 * mode parsing, host ownership, local-state seeding, installed-artifact gates,
 * result freshness, and the final no-false-green verdict; native I/O remains in
 * `ios-voice-selftest-smoke.mjs`.
 *
 * The no-false-green contract matches `voice-selftest.android.spec.ts`: overall
 * must be `pass` AND each of the asr/send/tts stages must be `pass`. A `skipped`
 * stage (e.g. local-inference ASR not provisioned) is NOT a pass — it fails the
 * lane loudly so "can't run here" never reads as "verified working".
 */

/** The three stages every real voice round-trip must clear, in order. */
export const REQUIRED_VOICE_STAGES = ["asr", "send", "tts"];

export const IOS_LOCAL_AGENT_IPC_BASE = "eliza-local-agent://ipc";
export const IOS_VOICE_SELFTEST_REQUEST_BUDGET_MS = 20 * 60_000;

export const REQUIRED_IOS_LOCAL_VOICE_ASSETS = Object.freeze([
  {
    id: "asr-model",
    relativePaths: ["asr/eliza-1-asr.gguf"],
    destination: "asr/eliza-1-asr.gguf",
    minBytes: 1_000_000,
    magic: "GGUF",
  },
  {
    id: "asr-mmproj",
    relativePaths: ["asr/eliza-1-asr-mmproj.gguf"],
    destination: "asr/eliza-1-asr-mmproj.gguf",
    minBytes: 1_000_000,
    magic: "GGUF",
  },
  {
    id: "tts-base",
    relativePaths: [
      "tts/omnivoice-base-Q4_K_M.gguf",
      "tts/omnivoice-base-q4_k_m.gguf",
    ],
    destination: "tts/omnivoice-base-Q4_K_M.gguf",
    minBytes: 1_000_000,
    magic: "GGUF",
  },
  {
    id: "tts-tokenizer",
    relativePaths: [
      "tts/omnivoice-tokenizer-Q4_K_M.gguf",
      "tts/omnivoice-tokenizer-q4_k_m.gguf",
    ],
    destination: "tts/omnivoice-tokenizer-Q4_K_M.gguf",
    minBytes: 1_000_000,
    magic: "GGUF",
  },
  {
    id: "vad",
    candidates: [
      {
        relativePath: "vad/silero-vad-v5.gguf",
        destination: "vad/silero-vad-v5.gguf",
        magic: "GGUF",
      },
      {
        relativePath: "vad/silero-vad-v5.1.2.ggml.bin",
        destination: "vad/silero-vad-v5.1.2.ggml.bin",
        magic: "ggml",
      },
    ],
    minBytes: 1_000,
  },
]);

const REQUIRED_FUSED_VOICE_SYMBOLS = [
  "eliza_inference_asr_transcribe",
  "eliza_inference_tts_synthesize",
  "eliza_inference_vad_supported",
];

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/** Parse the explicit orchestrator mode. The shipped command defaults local. */
export function parseIosVoiceSelfTestMode(argv) {
  const raw = valueAfter(argv, "--mode") ?? "local";
  if (raw !== "local" && raw !== "remote") {
    throw new Error(
      `--mode must be local or remote, got ${JSON.stringify(raw)}`,
    );
  }
  const apiBase = valueAfter(argv, "--api-base")?.trim() || null;
  if (raw === "local" && apiBase && apiBase !== IOS_LOCAL_AGENT_IPC_BASE) {
    throw new Error(
      `--mode local always uses ${IOS_LOCAL_AGENT_IPC_BASE}; remove --api-base or pass that exact IPC base.`,
    );
  }
  return { mode: raw, apiBase };
}

/** Decide whether this process owns a remote compatibility host. */
export function planIosVoiceSelfTestHost({ mode, apiBase }) {
  if (mode === "local") {
    return {
      apiBase: IOS_LOCAL_AGENT_IPC_BASE,
      ownsHostAgent: false,
    };
  }
  return {
    apiBase,
    ownsHostAgent: !apiBase,
  };
}

/** Build the exact Preferences state for one uniquely-owned smoke run. */
export function buildIosVoiceSelfTestPreferenceSeed({
  mode,
  apiBase,
  runId,
  requestedAt,
  deadlineAt,
}) {
  if (!runId?.trim()) throw new Error("voice self-test runId is required");
  if (!Number.isFinite(Date.parse(requestedAt))) {
    throw new Error(`voice self-test requestedAt is invalid: ${requestedAt}`);
  }
  const requestedAtMs = Date.parse(requestedAt);
  const deadlineAtMs = Date.parse(deadlineAt);
  if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= requestedAtMs) {
    throw new Error(`voice self-test deadlineAt is invalid: ${deadlineAt}`);
  }
  const request = JSON.stringify({
    mode,
    apiBase,
    runId,
    requestedAt,
    deadlineAt,
  });
  const requestedResult = JSON.stringify({
    ok: false,
    phase: "requested",
    mode,
    apiBase,
    runId,
    requestedAt,
    deadlineAt,
    updatedAt: requestedAt,
  });
  const entries = {
    "eliza:ios-voice-selftest:request": request,
    "eliza:ios-voice-selftest:result": requestedResult,
  };
  if (mode === "local") {
    entries["eliza:mobile-runtime-mode"] = "local";
    entries["eliza:first-run-complete"] = "1";
  } else {
    entries["eliza:ios-onboarding-smoke:request"] = JSON.stringify({ apiBase });
    entries["eliza:ios-onboarding-smoke:result"] = JSON.stringify({
      ok: false,
      phase: "requested",
      apiBase,
      runId,
      updatedAt: requestedAt,
    });
  }
  return entries;
}

/** A terminal result belongs to this run only when id and timestamps agree. */
export function isIosVoiceSelfTestResultFresh(
  result,
  { runId, requestedAtMs, deadlineAtMs = Number.POSITIVE_INFINITY },
) {
  if (!result || typeof result !== "object" || result.runId !== runId) {
    return false;
  }
  const terminalAt = Date.parse(result.finishedAt ?? result.updatedAt ?? "");
  return (
    Number.isFinite(terminalAt) &&
    terminalAt >= requestedAtMs &&
    terminalAt <= deadlineAtMs
  );
}

/** Select and validate the one native boot trace owned by this request. */
export function selectIosVoiceSelfTestBootTrace(entries, { requestedAtMs }) {
  const current = entries.filter((entry) => {
    const timestamp = Date.parse(entry?.ts ?? "");
    return Number.isFinite(timestamp) && timestamp >= requestedAtMs;
  });
  const traceIds = new Set(
    current
      .map((entry) => entry?.traceId)
      .filter((value) => typeof value === "string" && value.length > 0),
  );
  if (current.length === 0 || traceIds.size !== 1) {
    throw new Error(
      `native boot trace is not owned by exactly one current launch (entries=${current.length}, traceIds=${traceIds.size})`,
    );
  }
  const traceId = Array.from(traceIds)[0];
  const owned = current.filter((entry) => entry?.traceId === traceId);
  const hasStage = (predicate) => owned.some(predicate);
  const required = {
    processLaunch: hasStage((entry) => entry.stage === "process-launch"),
    engineReady: hasStage(
      (entry) =>
        (entry.stage === "engine-bootstrap-ok" && entry.engineMode === "bun") ||
        ((entry.stage === "engine-start-ok" ||
          entry.stage === "engine-adopted-running") &&
          entry.engine === "bun"),
    ),
    agentReady: hasStage(
      (entry) =>
        (entry.stage === "agent-boot-phase" && entry.phase === "ready") ||
        (entry.stage === "probe" && entry.ready === true),
    ),
  };
  if (Object.values(required).some((value) => value !== true)) {
    throw new Error(
      `native boot trace lacks required current-run stages: ${JSON.stringify(required)}`,
    );
  }
  return { entries: owned, traceId, required };
}

/** Return every reason an installed app is not valid local voice evidence. */
export function iosLocalVoiceArtifactProblems({
  manifest,
  expectedCommit,
  agentBundleBytes,
  engineBytes,
  engineAbiVersion,
  engineNoJit,
  engineExecutionProfile,
  architectures,
  exportedSymbols,
}) {
  const problems = [];
  if (manifest?.commit !== expectedCommit) {
    problems.push(
      `renderer commit ${manifest?.commit ?? "<missing>"} != ${expectedCommit}`,
    );
  }
  if (manifest?.capacitorTarget !== "ios") {
    problems.push(
      `renderer capacitorTarget ${manifest?.capacitorTarget ?? "<missing>"} != ios`,
    );
  }
  if (manifest?.runtimeMode !== "local") {
    problems.push(
      `renderer runtimeMode ${manifest?.runtimeMode ?? "<missing>"} != local`,
    );
  }
  if (!(agentBundleBytes > 0))
    problems.push("agent-bundle.js is missing or empty");
  if (!(engineBytes > 0)) problems.push("ElizaBunEngine is missing or empty");
  if (engineAbiVersion !== "3") {
    problems.push(`ElizaBunEngine ABI ${engineAbiVersion ?? "<missing>"} != 3`);
  }
  if (engineNoJit !== true) problems.push("ElizaBunEngineNoJIT is not true");
  if (engineExecutionProfile !== "ios-app-store-nojit") {
    problems.push(
      `ElizaBunEngine execution profile ${engineExecutionProfile ?? "<missing>"} != ios-app-store-nojit`,
    );
  }
  if (!architectures?.includes("arm64")) {
    problems.push(
      `app architecture does not include arm64: ${architectures ?? ""}`,
    );
  }
  for (const symbol of REQUIRED_FUSED_VOICE_SYMBOLS) {
    if (!exportedSymbols?.includes(symbol)) {
      problems.push(`fused local-voice symbol ${symbol} is missing`);
    }
  }
  return problems;
}

/**
 * Reduce a {@link VoiceSelfTestReport}-shaped object to a hard pass/fail verdict
 * with human-readable reasons for every failing check. Returns `pass:false`
 * (never throws) for a missing/corrupt report so the caller can surface the raw
 * payload; the orchestrator turns `pass:false` into a nonzero exit.
 *
 * @param {unknown} report Parsed voice self-test report (or null/garbage).
 * @returns {{ pass: boolean, reasons: string[], stageStatuses: Record<string,string>, transcript: string, reply: string, overall: string }}
 */
export function evaluateVoiceSelfTestReport(
  report,
  { requireLocalInference = false } = {},
) {
  // Both boundaries call this dependency-neutral contract. The host still
  // reevaluates the raw renderer report instead of trusting its terminal `ok`.
  const reasons = [];
  if (!report || typeof report !== "object") {
    return {
      pass: false,
      reasons: ["report is missing or not an object"],
      stageStatuses: {},
      transcript: "",
      reply: "",
      overall: "unknown",
    };
  }

  const overall =
    typeof report.overall === "string" ? report.overall : "unknown";
  const transcript =
    typeof report.transcript === "string" ? report.transcript : "";
  const reply = typeof report.reply === "string" ? report.reply : "";
  const stages = Array.isArray(report.stages) ? report.stages : [];

  const stageStatuses = {};
  for (const stage of stages) {
    if (stage && typeof stage.stage === "string") {
      stageStatuses[stage.stage] =
        typeof stage.status === "string" ? stage.status : "unknown";
    }
  }

  if (overall !== "pass") {
    reasons.push(`overall is "${overall}", expected "pass"`);
  }

  for (const name of REQUIRED_VOICE_STAGES) {
    const status = stageStatuses[name];
    if (status === undefined) {
      reasons.push(`stage "${name}" is missing from the report`);
    } else if (status !== "pass") {
      // A skipped stage fails just like a failed one — parity with the Android
      // spec's no-false-green rule.
      reasons.push(`stage "${name}" is "${status}", expected "pass"`);
    }
  }

  // The fixture says "what time is it"; a real transcript must contain "time",
  // and a real agent turn must produce a non-empty reply.
  if (!transcript.toLowerCase().includes("time")) {
    reasons.push(
      `transcript ${JSON.stringify(transcript)} does not contain "time"`,
    );
  }
  if (reply.trim().length === 0) {
    reasons.push("agent reply is empty");
  }
  if (requireLocalInference) {
    if (report.platform !== "ios") {
      reasons.push(
        `report platform ${JSON.stringify(report.platform ?? "<missing>")} != "ios"`,
      );
    }
    if (report.mode !== "wav-direct") {
      reasons.push(
        `report mode ${JSON.stringify(report.mode ?? "<missing>")} != "wav-direct"`,
      );
    }
    if (report.ttsRoute !== "/api/tts/local-inference") {
      reasons.push(
        `report TTS route ${JSON.stringify(report.ttsRoute ?? "<missing>")} != "/api/tts/local-inference"`,
      );
    }
    const sendBackend =
      typeof report.sendBackend === "string" ? report.sendBackend.trim() : "";
    const model = sendBackend.startsWith("local-inference:")
      ? sendBackend.slice("local-inference:".length).trim()
      : "";
    if (!model || model === "unknown" || model === "unknown-model") {
      reasons.push(
        `send backend ${JSON.stringify(sendBackend || "<missing>")} does not prove a known local-inference model`,
      );
    }
  }

  return {
    pass: reasons.length === 0,
    reasons,
    stageStatuses,
    transcript,
    reply,
    overall,
  };
}
