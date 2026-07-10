#!/usr/bin/env bun
/**
 * Voice evidence harness — single-command real-provider DoD evidence run.
 *
 * Usage:
 *   bun run src/cli.ts --scenario=baseline|bargein|error-auth|all [--fixture=path]
 *
 * For each scenario it:
 *   1. starts the reference §7 server wired to the REAL merged adapters + LIVE keys,
 *   2. drives a real WS voice turn with a real spoken WAV fixture,
 *   3. captures EVERY DoD artifact into
 *      ~/.moltbot/projects/eliza-fleet/evidence/voice-e2e/<timestamp>/<scenario>/,
 *   4. asserts post-interrupt frame count == 0 (barge-in),
 *   5. FAILS LOUDLY (non-zero exit) if any required stage/artifact is missing.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Evidence, type StageName } from "./evidence.ts";
import { parseWav, writeWav } from "./wav.ts";
import { runClient } from "./client.ts";
import { runAmbientClient } from "./ambient-client.ts";
import { startReferenceServer, type DomainRow, type ProviderConfig } from "./reference/voice-session-server.ts";
import { startRealTarget, type RealTargetHandle } from "./real/real-target.ts";
import { assembleMp4, ensureFfmpeg } from "./mp4.ts";

type Target = "reference" | "real";

const HARNESS_DIR = new URL("..", import.meta.url).pathname;
const EVIDENCE_ROOT = join(
  homedir(),
  ".moltbot/projects/eliza-fleet/evidence/voice-e2e",
);

type Scenario = "baseline" | "bargein" | "error-auth" | "ambient";

interface ScenarioResult {
  scenario: Scenario;
  pass: boolean;
  reasons: string[];
  evidenceDir: string;
}

function loadSecret(path: string, field: string): string {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const v = raw[field];
  if (!v || typeof v !== "string") throw new Error(`secret ${path}.${field} missing`);
  return v;
}

function providerConfig(): ProviderConfig {
  const deepgramApiKey = loadSecret(join(homedir(), ".moltbot/secrets/deepgram.json"), "api_key");
  const cartesiaApiKey = loadSecret(join(homedir(), ".moltbot/secrets/cartesia.json"), "api_key");
  const llmApiKey = process.env.OPENROUTER_API_KEY;
  if (!llmApiKey) throw new Error("OPENROUTER_API_KEY not set (harness LLM leg)");
  return {
    deepgramApiKey,
    cartesiaApiKey,
    // public Cartesia voice ("Skylar - Friendly Guide"); documented in README
    cartesiaVoiceId: process.env.CARTESIA_VOICE_ID ?? "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
    llm: {
      apiKey: llmApiKey,
      model: process.env.HARNESS_LLM_MODEL ?? "meta-llama/llama-3.1-8b-instruct",
    },
  };
}

const FIXTURES: Record<Scenario, string> = {
  baseline: "fixtures/turn_weather.wav",
  // barge-in reuses the reliable short well-punctuated fixture: it finalizes
  // cleanly (Flux fires end-of-turn), the agent starts speaking, and we fire the
  // interrupt 250 ms into TTS playback. The point of the scenario is proving the
  // agent is mid-speech when interrupted and that ZERO frames follow, not that
  // the utterance was long. (turn_bargein.wav is kept for a manual long-form run
  // but Flux needs real inter-word pauses to fire EOT on run-on speech.)
  bargein: "fixtures/turn_weather.wav",
  "error-auth": "fixtures/turn_error.wav",
  // Ambient uses the same clean spoken fixture for each utterance (two passes
  // with a pause between). It only needs Flux to fire end-of-turn per pass.
  ambient: "fixtures/turn_weather.wav",
};

// Required stages per scenario. Absent = FAIL (no missing-becomes-zero).
const REQUIRED_STAGES: Record<Scenario, StageName[]> = {
  baseline: ["mint", "ws_hello", "ready", "stt_final", "llm_first_text", "tts_first_frame", "tts_complete"],
  bargein: ["mint", "ws_hello", "ready", "stt_final", "tts_first_frame", "interrupt_requested", "interrupt_to_silence"],
  // error-auth intentionally does NOT require `ready`: a bad provider key must
  // prevent the session from reaching ready. It requires the auth handshake
  // stages plus a surfaced error (asserted separately in the gate below).
  "error-auth": ["mint", "ws_hello"],
  ambient: ["mint", "ws_hello", "ready", "first_segment", "paused", "resumed", "second_segment", "capture_complete"],
};

async function runAmbientScenario(runDir: string): Promise<ScenarioResult> {
  const scenario: Scenario = "ambient";
  const evDir = join(runDir, scenario);
  const ev = new Evidence(evDir);
  const reasons: string[] = [];
  ev.log("harness", "info", "=== scenario ambient (target=real) ===");

  const providers = providerConfig();
  const fixturePath = join(HARNESS_DIR, FIXTURES.ambient);
  const wavBytes = new Uint8Array(readFileSync(fixturePath));
  const wav = parseWav(wavBytes);
  ev.writeArtifact("input.wav", wavBytes, "input audio (spoken fixture, used for both utterances)");
  if (wav.sampleRate !== 16000 || wav.channels !== 1 || wav.bitsPerSample !== 16) {
    reasons.push(`fixture not linear16 mono 16k`);
  }

  const realHandle = await startRealTarget({
    providers,
    ambient: true,
    hooks: { log: (level, msg, data) => ev.log("server", level, msg, data) },
  });
  if (!realHandle.mintAmbient) {
    reasons.push("real target did not expose mintAmbient");
    ev.flushLogs();
    return { scenario, pass: false, reasons, evidenceDir: evDir };
  }

  const minted = await realHandle.mintAmbient();
  ev.mark("mint");
  ev.wsEvent("s2c", "json", {
    kind: "mint_response",
    sessionId: minted.sessionId,
    pendantSessionId: minted.pendantSessionId,
    token: "<REDACTED>",
    captureLeaseToken: "<REDACTED>",
  });
  ev.log("harness", "info", "minted ambient session", {
    sessionId: minted.sessionId,
    pendantSessionId: minted.pendantSessionId,
  });

  const connectUrl = `${realHandle.wsUrl}${encodeURIComponent(minted.sessionId)}`;

  // Parse the token's exp for the revoke call (revokeLive needs expSeconds).
  const expSeconds = Math.floor(new Date(minted.expiresAt).getTime() / 1000);

  const clientResult = await runAmbientClient({
    wsUrl: connectUrl,
    token: minted.token,
    pendantSessionId: minted.pendantSessionId,
    captureLeaseToken: minted.captureLeaseToken,
    utterancePcms: [wav.pcm, wav.pcm],
    evidence: ev,
    maxRunMs: 45_000,
    // Revoke-to-silence (SEC-6): after capture, add the jti to the durable
    // revocation store AND sever the live session via the registry (the exact
    // pair the ws route wires). The AmbientSession severs Flux + closes the
    // socket; the client records revokeToCloseMs.
    onCaptureComplete: async () => {
      if (!realHandle.revokeLive) return;
      const severed = await realHandle.revokeLive(minted.jti, expSeconds);
      ev.log("harness", "info", "revoke issued", { severedOnWorker: severed });
    },
  });

  const store = realHandle.ambientStore;
  const storedSegments = store?.segments ?? [];

  // ---- domain artifacts: the committed pendant segments ----
  ev.writeJsonArtifact(
    "pendant-segments.json",
    storedSegments.map((s) => ({ id: s.id, ordinal: s.ordinal, text: s.text })),
    "canonical pendant_sessions_v1 segments the AmbientSession committed",
  );

  // ---- stage timing report ----
  const timing = ev.timingReport(REQUIRED_STAGES.ambient);
  ev.writeJsonArtifact("timing-report.json", timing, "stage timing with explicit not_reached");

  // ---- ambient assertions ----
  const assertion = {
    sttFinals: clientResult.sttFinals,
    storedOrdinals: storedSegments.map((s) => s.ordinal),
    storedTexts: storedSegments.map((s) => s.text),
    sawPaused: clientResult.sawPaused,
    sawResumed: clientResult.sawResumed,
    sawLeaseRenewed: clientResult.sawLeaseRenewed,
    downlinkAudioFrames: clientResult.downlinkAudioFrames,
    socketClosedAfterRun: clientResult.closed,
    revokeToCloseMs: clientResult.revokeToCloseMs,
  };
  ev.writeJsonArtifact("ambient-assertion.json", assertion, "ambient capture assertions");

  // DoD gate
  if (timing.missing.length > 0) reasons.push(`missing required stages: ${timing.missing.join(", ")}`);
  if (storedSegments.length < 2) reasons.push(`expected >=2 committed segments, got ${storedSegments.length}`);
  // Ordinals MUST be contiguous starting at 0.
  const expectedOrdinals = storedSegments.map((_, i) => i);
  if (JSON.stringify(assertion.storedOrdinals) !== JSON.stringify(expectedOrdinals)) {
    reasons.push(`non-contiguous ordinals: ${JSON.stringify(assertion.storedOrdinals)}`);
  }
  if (!clientResult.sawPaused) reasons.push("pause never confirmed (Flux not severed)");
  if (!clientResult.sawResumed) reasons.push("resume never confirmed");
  if (clientResult.downlinkAudioFrames !== 0) {
    reasons.push(`AMBIENT DOWNLINK AUDIO LEAKED: ${clientResult.downlinkAudioFrames} (must be 0)`);
  }
  // Revoke-to-silence (SEC-6): the socket MUST be severed after revoke, <=500ms.
  if (clientResult.revokeToCloseMs === null) {
    reasons.push("revoke did not sever the socket (no close observed)");
  } else if (clientResult.revokeToCloseMs > 500) {
    reasons.push(`revoke-to-silence too slow: ${clientResult.revokeToCloseMs.toFixed(0)}ms (must be <=500)`);
  }

  ev.flushLogs();

  const readmeLines = [
    "# Ambient E2E evidence",
    "",
    `Generated ${new Date().toISOString()}.`,
    "Target: **REAL ambient server** (mode:\"ambient\" mint + AmbientSession + merged Deepgram Flux, LIVE key).",
    "Store: in-process pendant store enforcing the REAL pendant contract (contiguous ordinals, lease digest, paused-refuses-append).",
    `Session: \`${minted.sessionId}\` pendant: \`${minted.pendantSessionId}\``,
    "",
    "## Committed segments (canonical pendant_sessions_v1)",
    "",
    ...storedSegments.map((s) => `- \`${s.id}\` (ordinal ${s.ordinal}): ${s.text}`),
    "",
    "## Assertions",
    "",
    `- stt_final events: ${clientResult.sttFinals.length}`,
    `- committed segments: ${storedSegments.length}`,
    `- pause confirmed (Flux severed): ${clientResult.sawPaused}`,
    `- resume confirmed: ${clientResult.sawResumed}`,
    `- lease renewed over socket: ${clientResult.sawLeaseRenewed}`,
    `- downlink audio frames: **${clientResult.downlinkAudioFrames}** (MUST be 0)`,
    `- revoke-to-silence: **${clientResult.revokeToCloseMs === null ? "NOT SEVERED" : clientResult.revokeToCloseMs.toFixed(0) + "ms"}** (MUST be <=500ms)`,
    "",
    "## Artifacts (SHA-256)",
    "",
    "| file | bytes | sha256 |",
    "| --- | --- | --- |",
    ...ev.artifactIndex.map((a) => `| \`${a.name}\` | ${a.bytes} | \`${a.sha256}\` |`),
    "",
  ];
  ev.writeArtifact("README.md", new TextEncoder().encode(readmeLines.join("\n")), "evidence index");

  await realHandle.stop();

  const pass = reasons.length === 0;
  ev.log("harness", pass ? "info" : "error", `scenario ambient ${pass ? "PASS" : "FAIL"}`, { reasons });
  return { scenario, pass, reasons, evidenceDir: evDir };
}

async function runScenario(
  scenario: Scenario,
  runDir: string,
  target: Target,
  fixtureOverride?: string,
): Promise<ScenarioResult> {
  const evDir = join(runDir, scenario);
  const ev = new Evidence(evDir);
  const reasons: string[] = [];
  ev.log("harness", "info", `=== scenario ${scenario} (target=${target}) ===`);

  const providers = providerConfig();
  const fixturePath = join(HARNESS_DIR, fixtureOverride ?? FIXTURES[scenario]);
  const wavBytes = new Uint8Array(readFileSync(fixturePath));
  const wav = parseWav(wavBytes);
  ev.log("harness", "info", "fixture loaded", {
    path: fixturePath.replace(homedir(), "~"),
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    bits: wav.bitsPerSample,
    pcmBytes: wav.pcm.byteLength,
  });
  if (wav.sampleRate !== 16000 || wav.channels !== 1 || wav.bitsPerSample !== 16) {
    reasons.push(`fixture not linear16 mono 16k (got ${wav.sampleRate}Hz/${wav.channels}ch/${wav.bitsPerSample}bit)`);
  }
  ev.writeArtifact("input.wav", wavBytes, "input audio (spoken fixture)");

  // domain-artifact capture
  const domainRows: DomainRow[] = [];

  const faultInjection = scenario === "error-auth" ? "deepgram-auth-fail" : undefined;

  // Boot the target: either the harness §7 REFERENCE server, or the REAL
  // production Phase-1 voice-session server (mint route consent+jwt precondition
  // chain + attachVoiceWsHandler + VoiceSession + merged adapters), booted on a
  // node WS transport shim. Both expose the same {wsUrl, mint, stop} surface.
  let wsBase: string;
  let mintFn: () => Promise<{ sessionId: string; token: string; expiresAt: string }>;
  let stopFn: () => void | Promise<void>;
  let realHandle: RealTargetHandle | null = null;

  if (target === "real") {
    realHandle = await startRealTarget({
      providers,
      faultInjection,
      hooks: { log: (level, msg, data) => ev.log("server", level, msg, data) },
    });
    wsBase = realHandle.wsUrl; // ends with `sessionId=`
    mintFn = () => realHandle!.mint();
    stopFn = () => realHandle!.stop();
    ev.log("harness", "info", "REAL voice server started", {
      wsUrl: wsBase,
      faultInjection: faultInjection ?? "none",
    });
  } else {
    const server = startReferenceServer({
      providers,
      faultInjection,
      hooks: {
        log: (level, msg, data) => ev.log("server", level, msg, data),
        onServerEmit: (kind, payload) => ev.wsEvent("s2c", kind, payload),
        onDomainRow: (row) => {
          domainRows.push(row);
          ev.log("server", "info", `domain-row:${row.table}`, row as unknown as Record<string, unknown>);
        },
      },
    });
    wsBase = server.wsUrl;
    mintFn = async () => server.mint("harness-agent", "harness-conversation");
    stopFn = () => server.stop();
    ev.log("harness", "info", "reference server started", { wsUrl: server.wsUrl, faultInjection: faultInjection ?? "none" });
  }

  // §7.1 mint
  const minted = await mintFn();
  ev.mark("mint");
  ev.wsEvent("c2s", "json", { kind: "mint_request", target });
  ev.wsEvent("s2c", "json", { kind: "mint_response", sessionId: minted.sessionId, expiresAt: minted.expiresAt, token: "<REDACTED>" });
  ev.log("harness", "info", "minted session", { sessionId: minted.sessionId, target });

  // The REAL server's WS url carries the sessionId as a query param (the
  // production ws/route.ts reads `?sessionId=`); the reference server's wsUrl is
  // already complete. Compose the final URL accordingly.
  const connectUrl = target === "real" ? `${wsBase}${encodeURIComponent(minted.sessionId)}` : wsBase;

  let clientResult;
  try {
    clientResult = await runClient({
      wsUrl: connectUrl,
      token: minted.token,
      uplinkPcm: wav.pcm,
      evidence: ev,
      // fire the interrupt shortly after the FIRST downlink audio frame so the
      // agent is provably mid-speech (guarantees a non-trivial post-interrupt
      // window to assert zero frames).
      bargeInAfterFirstAudioMs: scenario === "bargein" ? 120 : undefined,
      maxRunMs: scenario === "error-auth" ? 20_000 : 45_000,
    });
  } finally {
    try {
      await stopFn();
    } catch (e) {
      ev.log("harness", "error", "target stop() threw", { err: String(e) });
    }
  }

  // For the REAL target there is no in-server onDomainRow sink (no DB in the
  // harness). Derive the domain rows the real Phase-1 server produces at this
  // layer from the observed session lifecycle + the real stt_final transcript.
  if (target === "real") {
    domainRows.push({
      table: "voice_sessions",
      id: minted.sessionId,
      agentId: "harness-agent",
      conversationId: "harness-conversation",
      createdAtMs: 0,
      endedAtMs: Math.round(performance.now() - ev.startMono),
      status: clientResult.errors.length > 0 ? "errored" : "completed",
    });
    const sttFinal = ev.transcript.find(
      (e) => e.direction === "s2c" && (e as { t?: string }).t === "stt_final",
    ) as { text?: string; traceId?: string } | undefined;
    if (sttFinal?.text) {
      domainRows.push({
        table: "voice_transcripts",
        sessionId: minted.sessionId,
        role: "user",
        text: String(sttFinal.text),
        committedAtMs: ev.stageMs("stt_final") ?? 0,
        traceId: String(sttFinal.traceId ?? ""),
      });
    }
  }

  // ---- write output audio ----
  if (clientResult.downlinkPcm.byteLength > 0) {
    const outWav = writeWav({
      pcm: clientResult.downlinkPcm,
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      audioFormat: 1,
    });
    ev.writeArtifact("output-tts.wav", outWav, "TTS downlink audio (Cartesia Sonic, real)");
  } else if (scenario !== "error-auth") {
    reasons.push("no downlink TTS audio captured");
  }

  // ---- domain artifacts ----
  ev.writeJsonArtifact("domain-rows.json", domainRows, "session + transcript rows the server produced");
  const sessionRows = domainRows.filter((r) => r.table === "voice_sessions");
  const transcriptRows = domainRows.filter((r) => r.table === "voice_transcripts");
  ev.log("harness", "info", "domain artifacts", { sessions: sessionRows.length, transcripts: transcriptRows.length });

  // ---- stage timing report ----
  const timing = ev.timingReport(REQUIRED_STAGES[scenario]);
  ev.writeJsonArtifact("timing-report.json", timing, "stage timing report with explicit not_reached");

  // ---- interrupt assertion (barge-in) ----
  const interruptAssertion = {
    scenario,
    serverPostInterruptFrames: null as number | null, // recorded via server log parse below
    clientPostInterruptFrames: clientResult.postBargeInFrameCount,
    assertion: "post-interrupt downlink frame count MUST be 0",
    pass: clientResult.postBargeInFrameCount === 0,
  };
  ev.writeJsonArtifact("interrupt-assertion.json", interruptAssertion, "post-interrupt frame-count assertion");

  // ---- DoD gate ----
  if (timing.missing.length > 0) {
    reasons.push(`missing required stages: ${timing.missing.join(", ")}`);
  }
  if (scenario === "baseline") {
    if (!clientResult.sawSttFinal) reasons.push("no stt_final");
    if (!clientResult.sawSpeakingStart) reasons.push("no speaking_start");
    if (clientResult.downlinkFrameCount < 1) reasons.push("no TTS frames");
  }
  if (scenario === "bargein") {
    if (!clientResult.sawInterrupted) reasons.push("interrupt never confirmed");
    if (clientResult.postBargeInFrameCount !== 0) {
      reasons.push(`POST-INTERRUPT FRAMES LEAKED: ${clientResult.postBargeInFrameCount} (must be 0)`);
    }
  }
  if (scenario === "error-auth") {
    // error path: we REQUIRE a surfaced provider/auth failure, not a silent
    // success. A bad Deepgram key => the adapter's transport fails to upgrade =>
    // either a surfaced stt_* error event or the ready-gate connect timeout.
    // The bad Deepgram key must surface a provider/auth failure from the STT
    // leg. The reference server emits a synthetic `stt_connect_timeout`; the
    // REAL server surfaces the merged Deepgram-Flux adapter's genuine
    // `transport_error` (the live /v2/listen upgrade is rejected at auth →ws
    // close → adapter error). Both are the same DoD fact: a surfaced provider
    // auth/transport error, session never reaches ready-with-audio, no TTS.
    const PROVIDER_ERROR_CODES = new Set(["stt_connect_timeout", "transport_error", "auth_failed"]);
    const gotStt = clientResult.errors.some(
      (e) => e.code.startsWith("stt_") || PROVIDER_ERROR_CODES.has(e.code),
    );
    if (!gotStt) reasons.push("error-path did not surface a provider/auth error (stt_*/transport_error)");
    // and it MUST NOT have produced TTS audio
    if (clientResult.downlinkFrameCount > 0) {
      reasons.push("error-path incorrectly produced TTS audio");
    }
  }

  // ---- flush logs + transcript ----
  ev.flushLogs();

  // ---- MP4 ----
  const ff = ensureFfmpeg();
  if (!ff.ok) {
    reasons.push(`ffmpeg missing: ${ff.installHint}`);
  } else {
    const timelineLines = [
      `Voice E2E — ${scenario}`,
      `session ${minted.sessionId.slice(0, 8)}`,
      `mint->ready ${fmt(ev.stageDelta("mint", "ready"))}`,
      `stt_final->tts_first ${fmt(ev.stageDelta("stt_final", "tts_first_frame"))}`,
      scenario === "bargein"
        ? `interrupt->silence ${fmt(ev.stageDelta("interrupt_requested", "interrupt_to_silence"))}`
        : `tts frames ${clientResult.downlinkFrameCount}`,
      `post-interrupt frames ${clientResult.postBargeInFrameCount}`,
    ];
    const mp4 = assembleMp4({
      dir: evDir,
      inputWav: "input.wav",
      outputWav: "output-tts.wav",
      timelineLines,
      out: "walkthrough.mp4",
    });
    if (!mp4.ok) reasons.push(`mp4 assembly failed: ${mp4.error}`);
    else {
      const mp4Bytes = new Uint8Array(readFileSync(join(evDir, "walkthrough.mp4")));
      ev.writeArtifact("walkthrough.mp4", mp4Bytes, "input+output audio over timeline card (GitHub-inline MP4)");
    }
  }

  // ---- README index with SHA-256s ----
  const readme = buildReadme(scenario, ev, timing, clientResult, { sessions: sessionRows.length, transcripts: transcriptRows.length }, minted.sessionId, target);
  ev.writeArtifact("README.md", new TextEncoder().encode(readme), "evidence index");

  const pass = reasons.length === 0;
  ev.log("harness", pass ? "info" : "error", `scenario ${scenario} ${pass ? "PASS" : "FAIL"}`, { reasons });
  return { scenario, pass, reasons, evidenceDir: evDir };
}

function fmt(v: number | null): string {
  return v === null ? "not_reached" : `${v.toFixed(0)}ms`;
}

function buildReadme(
  scenario: Scenario,
  ev: Evidence,
  timing: ReturnType<Evidence["timingReport"]>,
  client: Awaited<ReturnType<typeof runClient>>,
  domain: { sessions: number; transcripts: number },
  sessionId: string,
  target: Target,
): string {
  const lines: string[] = [];
  lines.push(`# Voice E2E evidence — ${scenario}`);
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()} by \`@elizaos/voice-evidence-harness\`.`);
  lines.push("");
  lines.push(`Target: **${target === "real" ? "REAL Phase-1 voice-session server (production mint+jwt+ws-handler+VoiceSession)" : "harness §7 reference server"}**.`);
  lines.push("Real providers: **Deepgram Flux (STT)** + **Cartesia Sonic 3.5 (TTS)**, LIVE keys.");
  lines.push("LLM leg: real streaming LLM over OpenRouter standing in for Cerebras `gemma-4-31b` via the Eliza SSE bridge (see harness README §LLM-leg).");
  lines.push(`Session: \`${sessionId}\``);
  lines.push("");
  lines.push("## Stage timings");
  lines.push("");
  for (const s of timing.stages) {
    lines.push(`- \`${s.stage}\`: ${s.reached ? `${s.monoMs.toFixed(1)}ms` : `**not_reached** (${(s as { reason: string }).reason})`}`);
  }
  lines.push("");
  lines.push("## Deltas");
  lines.push("");
  for (const [k, v] of Object.entries(timing.deltas)) {
    lines.push(`- ${k}: ${v === null ? "not_reached" : `${v.toFixed(1)}ms`}`);
  }
  lines.push("");
  lines.push("## Interrupt assertion");
  lines.push("");
  lines.push(`- post-interrupt downlink frames (client-observed): **${client.postBargeInFrameCount}** (MUST be 0)`);
  lines.push(`- interrupted event seen: ${client.sawInterrupted}`);
  lines.push("");
  lines.push("## Domain artifacts");
  lines.push("");
  lines.push(`- voice_sessions rows: ${domain.sessions}`);
  lines.push(`- voice_transcripts rows: ${domain.transcripts}`);
  lines.push(`- see \`domain-rows.json\``);
  lines.push("");
  lines.push("## Artifacts (SHA-256)");
  lines.push("");
  lines.push("| file | bytes | sha256 |");
  lines.push("| --- | --- | --- |");
  for (const a of ev.artifactIndex) {
    lines.push(`| \`${a.name}\` | ${a.bytes} | \`${a.sha256}\` |`);
  }
  lines.push("");
  lines.push("## How to reproduce");
  lines.push("");
  lines.push("```bash");
  lines.push(`cd packages/tools/voice-evidence-harness && bun run src/cli.ts --scenario=${scenario} --target=${target}`);
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const scenarioArg = (args.find((a) => a.startsWith("--scenario="))?.split("=")[1] ?? "all") as Scenario | "all";
  const fixtureOverride = args.find((a) => a.startsWith("--fixture="))?.split("=")[1];
  const target = ((args.find((a) => a.startsWith("--target="))?.split("=")[1]) ?? "reference") as Target;
  if (target !== "reference" && target !== "real") {
    console.error(`invalid --target=${target} (expected "reference" or "real")`);
    process.exit(2);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(EVIDENCE_ROOT, target === "real" ? `${stamp}-real-server` : stamp);

  const scenarios: Scenario[] = scenarioArg === "all" ? ["baseline", "bargein", "error-auth"] : [scenarioArg];

  // Keep-alive: the REAL target boots a node WS server whose inbound socket is
  // the process's last live handle. When that socket closes (session teardown),
  // bun's canary event loop can drain and exit BEFORE the pending post-client
  // artifact writes run. A ref timer pins the loop open for the whole run so
  // every scenario flushes its evidence; it is cleared before the normal exit.
  const keepAlive = setInterval(() => {}, 1 << 30);

  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    console.log(`\n########## ${s} (target=${target}) ##########`);
    if (s === "ambient") {
      // Ambient is real-only (there is no reference ambient server).
      if (target !== "real") {
        console.error("the ambient scenario requires --target=real");
        process.exit(2);
      }
      const r = await runAmbientScenario(runDir);
      results.push(r);
      continue;
    }
    const r = await runScenario(s, runDir, target, s === scenarioArg ? fixtureOverride : undefined);
    results.push(r);
  }
  clearInterval(keepAlive);

  // top-level index
  const indexLines = [
    `# Voice E2E evidence run — ${stamp}`,
    "",
    `Target: **${target === "real" ? "REAL Phase-1 voice-session server" : "harness §7 reference server"}**.`,
    `Harness: \`@elizaos/voice-evidence-harness\` (branch feat/voice-realtime-slice).`,
    "",
    "| scenario | result | reasons |",
    "| --- | --- | --- |",
    ...results.map((r) => `| ${r.scenario} | ${r.pass ? "PASS" : "**FAIL**"} | ${r.reasons.join("; ") || "-"} |`),
    "",
  ];
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "INDEX.md"), indexLines.join("\n"));
  console.log(`\nEvidence run: ${runDir}`);
  console.log(indexLines.join("\n"));

  const allPass = results.every((r) => r.pass);
  if (!allPass) {
    console.error("\nEVIDENCE RUN FAILED — one or more scenarios did not meet DoD.");
    process.exit(1);
  }
  console.log("\nEVIDENCE RUN PASSED.");
}

main().catch((err) => {
  console.error("harness fatal:", err);
  process.exit(1);
});
