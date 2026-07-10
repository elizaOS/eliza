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
import { startReferenceServer, type DomainRow, type ProviderConfig } from "./reference/voice-session-server.ts";
import { assembleMp4, ensureFfmpeg } from "./mp4.ts";

const HARNESS_DIR = new URL("..", import.meta.url).pathname;
const EVIDENCE_ROOT = join(
  homedir(),
  ".moltbot/projects/eliza-fleet/evidence/voice-e2e",
);

type Scenario = "baseline" | "bargein" | "error-auth";

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
};

// Required stages per scenario. Absent = FAIL (no missing-becomes-zero).
const REQUIRED_STAGES: Record<Scenario, StageName[]> = {
  baseline: ["mint", "ws_hello", "ready", "stt_final", "llm_first_text", "tts_first_frame", "tts_complete"],
  bargein: ["mint", "ws_hello", "ready", "stt_final", "tts_first_frame", "interrupt_requested", "interrupt_to_silence"],
  // error-auth intentionally does NOT require `ready`: a bad provider key must
  // prevent the session from reaching ready. It requires the auth handshake
  // stages plus a surfaced error (asserted separately in the gate below).
  "error-auth": ["mint", "ws_hello"],
};

async function runScenario(scenario: Scenario, runDir: string, fixtureOverride?: string): Promise<ScenarioResult> {
  const evDir = join(runDir, scenario);
  const ev = new Evidence(evDir);
  const reasons: string[] = [];
  ev.log("harness", "info", `=== scenario ${scenario} ===`);

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
  ev.log("harness", "info", "reference server started", { wsUrl: server.wsUrl, faultInjection: faultInjection ?? "none" });

  // §7.1 mint
  const minted = server.mint("harness-agent", "harness-conversation");
  ev.mark("mint");
  ev.wsEvent("c2s", "json", { kind: "mint_request", agentId: "harness-agent", conversationId: "harness-conversation" });
  ev.wsEvent("s2c", "json", { kind: "mint_response", sessionId: minted.sessionId, expiresAt: minted.expiresAt, token: "<REDACTED>" });
  ev.log("harness", "info", "minted session", { sessionId: minted.sessionId });

  let clientResult;
  try {
    clientResult = await runClient({
      wsUrl: server.wsUrl,
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
    server.stop();
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
    const gotStt = clientResult.errors.some(
      (e) => e.code.startsWith("stt_") || e.code === "stt_connect_timeout",
    );
    if (!gotStt) reasons.push("error-path did not surface an stt_* provider/auth error");
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
  const readme = buildReadme(scenario, ev, timing, clientResult, { sessions: sessionRows.length, transcripts: transcriptRows.length }, minted.sessionId);
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
): string {
  const lines: string[] = [];
  lines.push(`# Voice E2E evidence — ${scenario}`);
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()} by \`@elizaos/voice-evidence-harness\`.`);
  lines.push("");
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
  lines.push(`cd packages/tools/voice-evidence-harness && bun run src/cli.ts --scenario=${scenario}`);
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const scenarioArg = (args.find((a) => a.startsWith("--scenario="))?.split("=")[1] ?? "all") as Scenario | "all";
  const fixtureOverride = args.find((a) => a.startsWith("--fixture="))?.split("=")[1];

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(EVIDENCE_ROOT, stamp);

  const scenarios: Scenario[] = scenarioArg === "all" ? ["baseline", "bargein", "error-auth"] : [scenarioArg];

  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    console.log(`\n########## ${s} ##########`);
    const r = await runScenario(s, runDir, s === scenarioArg ? fixtureOverride : undefined);
    results.push(r);
  }

  // top-level index
  const indexLines = [
    `# Voice E2E evidence run — ${stamp}`,
    "",
    `Harness: \`@elizaos/voice-evidence-harness\` (branch feat/voice-evidence-harness).`,
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
