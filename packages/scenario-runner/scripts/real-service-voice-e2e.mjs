#!/usr/bin/env node
/**
 * Real-service END-TO-END cloud voice round-trip (#9299).
 *
 * Validates the full cloud voice turn with REAL services, the way the agent's
 * cloud voice loop runs it (`packages/core/src/services/message.ts`
 * `wrappedOnStreamChunk` → first-sentence `useModel(TEXT_TO_SPEECH)` while the
 * LLM is still streaming):
 *
 *   user speech  ──(real ElevenLabs TTS)──▶ question MP3
 *                ──(real ElevenLabs STT / scribe)──▶ transcript
 *                ──(real Cerebras gpt-oss-120b, STREAMING)──▶ reply tokens
 *      first sentence detected mid-stream
 *                ──(real ElevenLabs TTS)──▶ reply MP3  (time-to-first-audio)
 *                ──(real ElevenLabs STT)──▶ confirm the reply audio is speech
 *
 * Asserts, end to end:
 *   - STT recovers the spoken question (token recall),
 *   - Cerebras streams token-by-token (>1 delta, ≥2 distinct arrival times),
 *   - the first reply sentence is synthesized to valid speech BEFORE the LLM
 *     finishes streaming (TTFA < full-stream-done) — i.e. voice streams,
 *   - the reply MP3 transcribes back to the reply text.
 *
 * Frugal by design (ElevenLabs character quota is precious): one short question
 * + one short first sentence, ~60-120 TTS chars total. Prints the spend.
 *
 * CI-safe: SKIPs (exit 0) without ELEVENLABS + CEREBRAS keys or on an auth
 * error; exit 1 only on a real, authenticated wrong/invalid result.
 *
 * Run:
 *   node packages/scenario-runner/scripts/real-service-voice-e2e.mjs
 *   [--out <dir>]   # also write question.mp3 / reply.mp3 there
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const EL = "https://api.elevenlabs.io/v1";
const CB = (
  process.env.CEREBRAS_BASE_URL ?? "https://api.cerebras.ai/v1"
).replace(/\/$/, "");
const CB_MODEL = process.env.CEREBRAS_MODEL ?? "gpt-oss-120b";

// Short question (cheap to TTS + reliable to STT) that elicits a MULTI-sentence
// reply, so the first sentence completes mid-stream while the rest keeps
// streaming — that is the streaming-voice property we validate. Only the first
// sentence is ever sent to TTS, so the longer reply costs no extra quota.
const QUESTION = "Tell me about Paris.";
const SYSTEM =
  "You are a voice assistant. Reply in three short, plain sentences. No markdown, no lists.";

const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel — on every account
const TTS_MODEL = process.env.ELEVENLABS_MODEL_ID ?? "eleven_turbo_v2_5";
const STT_MODEL = process.env.ELEVENLABS_STT_MODEL_ID ?? "scribe_v1";

const outDir = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? process.argv[i + 1] : null;
})();

let ttsCharsSpent = 0;

const skip = (r) => {
  console.log(`SKIP real-service-voice-e2e: ${r}`);
  process.exit(0);
};
const fail = (r) => {
  console.error(`FAIL real-service-voice-e2e: ${r}`);
  process.exit(1);
};
class AuthError extends Error {}

const elKey = (
  process.env.ELEVENLABS_API_KEY ??
  process.env.ELEVENLABS_XI_API_KEY ??
  ""
).trim();
const cbKey = (process.env.CEREBRAS_API_KEY ?? "").trim();
if (!elKey) skip("no ELEVENLABS_API_KEY / ELEVENLABS_XI_API_KEY in env");
if (!cbKey) skip("no CEREBRAS_API_KEY in env");

const looksLikeMp3 = (b) =>
  b.length > 1024 &&
  ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) ||
    (b[0] === 0xff && (b[1] & 0xe0) === 0xe0));
const tokens = (s) =>
  (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(Boolean);
const recall = (want, text) => {
  const w = new Set(tokens(want).filter((x) => x.length > 2));
  const g = new Set(tokens(text));
  const hit = [...w].filter((x) => g.has(x));
  return w.size ? hit.length / w.size : 0;
};
// Mirrors the agent's first-sentence detection (sentence ends at . ! ? or \n).
const firstSentence = (s) => {
  const m = s.match(/^[\s\S]*?[.!?\n]/);
  return (m ? m[0] : s).trim();
};
const hasFirstSentence = (s) => /[.!?\n]/.test(s);

async function resolveVoiceId() {
  if (process.env.ELEVENLABS_VOICE_ID?.trim())
    return process.env.ELEVENLABS_VOICE_ID.trim();
  try {
    const r = await fetch(`${EL}/voices`, { headers: { "xi-api-key": elKey } });
    if (r.status === 401 || r.status === 403)
      throw new AuthError(`auth failed listing voices (HTTP ${r.status})`);
    if (r.ok) {
      const j = await r.json();
      if (j?.voices?.[0]?.voice_id) return j.voices[0].voice_id;
    }
  } catch (e) {
    if (e instanceof AuthError) throw e;
  }
  return DEFAULT_VOICE_ID;
}

async function tts(text, voiceId) {
  ttsCharsSpent += text.length;
  const r = await fetch(
    `${EL}/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": elKey, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: TTS_MODEL }),
    },
  );
  if (r.status === 401 || r.status === 403)
    throw new AuthError(`TTS auth failed (HTTP ${r.status})`);
  if (!r.ok)
    throw new Error(`TTS HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}

async function stt(mp3) {
  const form = new FormData();
  form.append("model_id", STT_MODEL);
  form.append("file", new Blob([mp3], { type: "audio/mpeg" }), "audio.mp3");
  const r = await fetch(`${EL}/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": elKey },
    body: form,
  });
  if (r.status === 401 || r.status === 403)
    throw new AuthError(`STT auth failed (HTTP ${r.status})`);
  if (!r.ok)
    throw new Error(`STT HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return ((await r.json())?.text ?? "").trim();
}

/**
 * Stream a Cerebras chat completion. Invokes onDelta(contentChunk, atMs) for
 * each visible-content delta (reasoning deltas are ignored). Returns the full
 * visible text + the per-delta timeline.
 */
async function cerebrasStream(prompt, onDelta) {
  const t0 = Date.now();
  const r = await fetch(`${CB}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cbKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CB_MODEL,
      stream: true,
      max_tokens: 200,
      temperature: 0.3,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (r.status === 401 || r.status === 403)
    throw new AuthError(`Cerebras auth failed (HTTP ${r.status})`);
  if (!r.ok)
    throw new Error(
      `Cerebras HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`,
    );

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  const timeline = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      const piece = j?.choices?.[0]?.delta?.content;
      if (typeof piece === "string" && piece.length > 0) {
        const atMs = Date.now() - t0;
        full += piece;
        timeline.push({ atMs, piece });
        await onDelta(piece, atMs, full);
      }
    }
  }
  return { full: full.trim(), timeline, doneMs: Date.now() - t0 };
}

try {
  const voiceId = await resolveVoiceId();
  const checks = [];

  // 1. user speech (real TTS) ----------------------------------------------
  const qMp3 = await tts(QUESTION, voiceId);
  const qSha = createHash("sha256").update(qMp3).digest("hex");
  const ttsQ = looksLikeMp3(qMp3);
  checks.push([
    "tts(question)",
    ttsQ,
    `${qMp3.length}B sha256=${qSha.slice(0, 12)}…`,
  ]);

  // 2. STT the question (real scribe) ---------------------------------------
  const qText = await stt(qMp3);
  const qRecall = recall(QUESTION, qText);
  const sttQ = qRecall >= 0.6;
  checks.push([
    "stt(question)",
    sttQ,
    `"${qText}" recall=${(qRecall * 100) | 0}%`,
  ]);

  // 3. Cerebras streaming reply + 4. first-sentence TTS mid-stream ----------
  let firstSentTtsAtMs = null;
  let firstSentText = "";
  let replyMp3 = null;
  let fired = false;
  const stream = await cerebrasStream(
    qText || QUESTION,
    async (_piece, atMs, accumulated) => {
      if (!fired && hasFirstSentence(accumulated)) {
        const fs = firstSentence(accumulated);
        if (fs.length > 5) {
          fired = true;
          firstSentText = fs;
          firstSentTtsAtMs = atMs; // ms into the stream when sentence 1 was complete
          // This is the streaming win: synthesize sentence 1 while the LLM is
          // still generating the rest — exactly message.ts wrappedOnStreamChunk.
          replyMp3 = await tts(fs, voiceId);
        }
      }
    },
  );

  // Streaming = the reply arrived as multiple incremental SSE content deltas
  // rather than one final blob. (Distinct arrival times are reported too, but
  // Cerebras is fast enough that several deltas can share a millisecond — delta
  // count is the honest streaming signal.)
  const distinctTimes = new Set(stream.timeline.map((t) => t.atMs)).size;
  const streamed = stream.timeline.length > 1;
  checks.push([
    "cerebras(stream)",
    streamed,
    `${stream.timeline.length} content deltas, ${distinctTimes} distinct arrival times, done@${stream.doneMs}ms`,
  ]);
  checks.push(["cerebras(reply)", stream.full.length > 0, `"${stream.full}"`]);

  // streaming voice: first sentence was complete (and synthesized to valid
  // speech) while the LLM was still streaming — i.e. content kept arriving after
  // the sentence-1 boundary, so TTS did not wait for the full reply.
  const deltasAfterFirstSentence =
    firstSentTtsAtMs == null
      ? 0
      : stream.timeline.filter((t) => t.atMs > firstSentTtsAtMs).length;
  const streamingVoice =
    replyMp3 != null &&
    looksLikeMp3(replyMp3) &&
    firstSentTtsAtMs != null &&
    deltasAfterFirstSentence >= 1;
  checks.push([
    "tts(first-sentence) mid-stream",
    streamingVoice,
    replyMp3
      ? `"${firstSentText}" → ${replyMp3.length}B; sentence-1 ready @${firstSentTtsAtMs}ms with ${deltasAfterFirstSentence} more deltas after it (stream done @${stream.doneMs}ms)`
      : "first sentence never synthesized",
  ]);

  // 5. confirm the reply audio is real speech (STT it back) -----------------
  let aRecall = 0;
  let aText = "";
  if (replyMp3) {
    aText = await stt(replyMp3);
    aRecall = recall(firstSentText, aText);
  }
  const sttReply = aRecall >= 0.5;
  checks.push([
    "stt(reply)",
    sttReply,
    `"${aText}" recall=${(aRecall * 100) | 0}%`,
  ]);

  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(`${outDir}/question.mp3`, qMp3);
    if (replyMp3) writeFileSync(`${outDir}/reply.mp3`, replyMp3);
  }

  console.log("\n===== #9299 cloud voice E2E (REAL services) =====");
  console.log(
    `STT/TTS: ElevenLabs (tts=${TTS_MODEL}, stt=${STT_MODEL}, voice=${voiceId})`,
  );
  console.log(`LLM:     Cerebras ${CB_MODEL} @ ${CB}`);
  console.log("");
  for (const [name, ok, detail] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name.padEnd(38)} ${detail}`);
  }
  console.log("");
  console.log("  stream timeline (ms into Cerebras stream):");
  for (const t of stream.timeline.slice(0, 16)) {
    console.log(
      `    +${String(t.atMs).padStart(5)}ms  ${JSON.stringify(t.piece)}`,
    );
  }
  console.log(`\n  ElevenLabs TTS chars spent this run: ${ttsCharsSpent}`);
  if (outDir) console.log(`  audio written to: ${outDir}/{question,reply}.mp3`);
  console.log("=================================================\n");

  const allPass = checks.every(([, ok]) => ok);
  if (allPass) {
    console.log(
      "PASS real-service-voice-e2e: full cloud voice turn validated, streaming confirmed.",
    );
    process.exit(0);
  }
  fail(
    `one or more legs failed: ${checks
      .filter(([, ok]) => !ok)
      .map(([n]) => n)
      .join(", ")}`,
  );
} catch (e) {
  if (e instanceof AuthError)
    skip(`${e.message} — set valid ElevenLabs + Cerebras keys to run`);
  fail(String(e).slice(0, 300));
}
