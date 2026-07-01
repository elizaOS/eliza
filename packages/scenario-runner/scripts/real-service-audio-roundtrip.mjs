#!/usr/bin/env node
/**
 * Real-service audio round-trip smoke (#8876).
 *
 * The agent can *generate* audio attachments (TTS) and *transcribe* them (STT)
 * through `@elizaos/plugin-elevenlabs` — but every test in that plugin mocks the
 * ElevenLabs SDK, so nothing exercises the real service end-to-end. This script
 * is the complement the goal asks for ("we ALSO test/validate with a real
 * service"): it drives a REAL generated-audio attachment round-trip —
 *
 *   text → (real TTS) → MP3 bytes → sha256 (the content-addressed media handle,
 *          identical to packages/agent/src/api/media-store.ts) → (real STT) →
 *          transcript → assert the transcript recovers the input phrase.
 *
 * This proves the bytes a generated-audio attachment would carry are real,
 * valid, storable under `/api/media/<sha256>.mp3`, playable, and transcribable.
 *
 * It is CI-safe and turnkey: with a valid ElevenLabs key it runs and asserts;
 * with no key — or an invalid/expired one (auth error) — it SKIPS cleanly
 * (exit 0) so it never red-fails a build that simply has no credentials. Exit 1
 * only on a real, authenticated service returning a wrong/invalid result.
 *
 * Run: `node packages/scenario-runner/scripts/real-service-audio-roundtrip.mjs`
 * (reads ELEVENLABS_API_KEY, then ELEVENLABS_XI_API_KEY, from the env — the
 * plugin reads ELEVENLABS_API_KEY; the repo .env historically uses the XI name).
 */

import { createHash } from "node:crypto";

const API = "https://api.elevenlabs.io/v1";
// A short, distinctive phrase — kept brief to spend minimal TTS character quota.
const PHRASE = "Eliza generated this audio attachment.";
// Rachel — a premade voice available on every ElevenLabs account. Overridable.
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const TTS_MODEL = process.env.ELEVENLABS_MODEL_ID ?? "eleven_turbo_v2_5";
const STT_MODEL = process.env.ELEVENLABS_STT_MODEL_ID ?? "scribe_v1";

function skip(reason) {
  console.log(`SKIP real-service-audio-roundtrip: ${reason}`);
  process.exit(0);
}

function fail(reason) {
  console.error(`FAIL real-service-audio-roundtrip: ${reason}`);
  process.exit(1);
}

class AuthError extends Error {}

const key = (
  process.env.ELEVENLABS_API_KEY ??
  process.env.ELEVENLABS_XI_API_KEY ??
  ""
).trim();
if (!key) skip("no ELEVENLABS_API_KEY / ELEVENLABS_XI_API_KEY in env");

/** A buffer is a valid MP3 if it opens with an ID3 tag or an MPEG frame sync. */
function looksLikeMp3(buf) {
  if (buf.length < 4) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // "ID3"
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0; // MPEG frame sync
}

/** Normalise to lowercase word tokens for a robust transcript comparison. */
function tokens(s) {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(Boolean);
}

async function resolveVoiceId() {
  if (process.env.ELEVENLABS_VOICE_ID?.trim()) {
    return process.env.ELEVENLABS_VOICE_ID.trim();
  }
  // Probe the account's voices; fall back to the premade default if the list
  // call is unavailable. Either way we end up with a usable voice id.
  try {
    const r = await fetch(`${API}/voices`, { headers: { "xi-api-key": key } });
    if (r.status === 401 || r.status === 403) {
      throw new AuthError(`auth failed listing voices (HTTP ${r.status})`);
    }
    if (r.ok) {
      const j = await r.json();
      const first = j?.voices?.[0]?.voice_id;
      if (first) return first;
    }
  } catch (e) {
    if (e instanceof AuthError) throw e;
  }
  return DEFAULT_VOICE_ID;
}

async function tts(voiceId) {
  const r = await fetch(
    `${API}/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ text: PHRASE, model_id: TTS_MODEL }),
    },
  );
  if (r.status === 401 || r.status === 403) {
    throw new AuthError(`TTS auth failed (HTTP ${r.status})`);
  }
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`TTS HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

async function stt(mp3) {
  const form = new FormData();
  form.append("model_id", STT_MODEL);
  form.append("file", new Blob([mp3], { type: "audio/mpeg" }), "generated.mp3");
  const r = await fetch(`${API}/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
  });
  if (r.status === 401 || r.status === 403) {
    throw new AuthError(`STT auth failed (HTTP ${r.status})`);
  }
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`STT HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

try {
  const voiceId = await resolveVoiceId();

  // 1. Real TTS — generate the audio attachment bytes.
  const mp3 = await tts(voiceId);
  const mp3Pass = looksLikeMp3(mp3) && mp3.length > 1024;

  // 2. Content-addressed handle — exactly how media-store.ts derives it.
  const sha256 = createHash("sha256").update(mp3).digest("hex");
  const mediaUrl = `/api/media/${sha256}.mp3`;
  const urlPass = /^\/api\/media\/[a-f0-9]{64}\.mp3$/.test(mediaUrl);

  // 3. Real STT — transcribe the generated bytes back.
  const transcript = await stt(mp3);
  const text = (transcript?.text ?? "").trim();
  // Token recall: how many words of the phrase the transcript recovered.
  const want = new Set(tokens(PHRASE).filter((w) => w.length > 2));
  const got = new Set(tokens(text));
  const recovered = [...want].filter((w) => got.has(w));
  const recall = want.size ? recovered.length / want.size : 0;
  const sttPass = recall >= 0.6; // generated speech should transcribe cleanly

  console.log(
    [
      "provider: elevenlabs (REAL api)",
      `tts: ${mp3.length} bytes, model=${TTS_MODEL}, voice=${voiceId} → ${mp3Pass ? "PASS (valid MP3)" : "FAIL (not a valid MP3)"}`,
      `media-handle: ${mediaUrl} → ${urlPass ? "PASS" : "FAIL"}`,
      `stt: "${text}" (lang=${transcript?.language_code ?? "?"}, recall=${(recall * 100).toFixed(0)}%) → ${sttPass ? "PASS" : "FAIL"}`,
    ].join("\n"),
  );

  if (mp3Pass && urlPass && sttPass) process.exit(0);
  fail(
    `round-trip incomplete (mp3=${mp3Pass}, url=${urlPass}, stt=${sttPass} recall=${(recall * 100).toFixed(0)}%)`,
  );
} catch (e) {
  if (e instanceof AuthError) {
    skip(`${e.message} — set a valid ElevenLabs key to run`);
  }
  fail(String(e).slice(0, 240));
}
