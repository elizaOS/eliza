/**
 * On-device AEC acoustic-loop evidence harness (#11373, follow-up to #9583).
 *
 * Drives a REAL speaker→air→mic echo loop on the device it runs on, through
 * the PRODUCTION `/api/voice/*` transport:
 *
 *   1. reads `/api/voice/audio-frames/status` (before);
 *   2. arms the agent's bounded AEC evidence capture
 *      (`POST /api/voice/aec-capture`);
 *   3. opens the real device microphone via getUserMedia with OS echo
 *      cancellation DISABLED (the measurement must see the raw acoustic echo);
 *   4. fetches real agent TTS from `POST /api/tts/local-inference` and plays
 *      it through the DEVICE SPEAKER via Web Audio, with a tap on the rendered
 *      graph acting as the live playback-reference producer →
 *      `POST /api/voice/playback-frames`;
 *   5. streams the mic PCM to `POST /api/voice/audio-frames` in the same
 *      base64 LE-s16 16 kHz mono wire shape, in real time, interleaved with
 *      playback;
 *   6. stops, flushes, reads status (after) + the agent-side aec-capture
 *      snapshot, and (on native) writes the whole result JSON to
 *      Documents/eliza-aec-loop-result.json so host tooling can pull it
 *      (`devicectl device copy from` on iOS, `adb pull` on Android).
 *
 * Exposed as `window.__aecLoop` (install-once, like `__diarizationPump`) and
 * auto-runs from an `#aec-loop?...` hash route so the whole loop is drivable
 * tap-free via the `elizaos://aec-loop?...` deep link on devices where no CDP
 * or Web Inspector session is possible. Evidence-only: it changes no product
 * behavior and never runs without the explicit hash/deep-link trigger or a
 * direct `window.__aecLoop.run(...)` call.
 */

import { resolveApiUrl } from "../utils/asset-url";

declare global {
  interface Window {
    __aecLoop?: AecLoopControl;
  }
}

const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 320; // 20 ms @ 16 kHz — the device wire frame size
const SHIP_INTERVAL_MS = 200;
const RESULT_FILENAME = "eliza-aec-loop-result.json";

export interface AecLoopRunOptions {
  /** Text synthesized by the on-device TTS and played from the speaker. */
  ttsText?: string;
  /**
   * Far-end audio URL played instead of on-device TTS. For devices where the
   * local TTS engine is not provisioned (no eliza-1 bundle staged): the loop's
   * subject — the production /api/voice/* transport, the AEC, and the real
   * device speaker→mic acoustics — is unchanged; only the speech source
   * differs. The URL must be reachable from the device WebView (e.g. an
   * `adb reverse` host server).
   */
  audioUrl?: string;
  /**
   * Near-end (double-talk) audio URL played through the SAME AudioContext but
   * connected directly to the destination — never through the playback tap —
   * so it reaches the mic acoustically while staying absent from the far-end
   * reference, which is the property that defines near-end speech for the
   * canceller. (A separate AudioContext does not work: on Android WebView a
   * second context created while the harness context holds the output stream
   * renders silently, verified on a Pixel 6a.) Starts when far-end playback
   * starts.
   */
  nearEndAudioUrl?: string;
  /** Agent-side capture window ceiling in seconds (default 30). */
  maxSeconds?: number;
  /** Extra mic tail after TTS playback ends, ms (default 2000). */
  tailMs?: number;
  /** Mic warmup before playback starts, ms (default 1500). */
  warmupMs?: number;
  /** Label copied into the result (e.g. "echo-only" / "double-talk"). */
  tag?: string;
  /** Also include the page-side 16 kHz PCM copies in the result JSON. */
  includePagePcm?: boolean;
  /** Skip writing Documents/eliza-aec-loop-result.json (default: write when
   * a native Filesystem bridge exists). */
  skipFileSink?: boolean;
}

export interface AecLoopResult {
  tag: string;
  startedAtIso: string;
  userAgent: string;
  statusBefore: unknown;
  statusAfter: unknown;
  aecCapture: unknown;
  micPosts: number;
  playPosts: number;
  micFramesSent: number;
  playFramesSent: number;
  shipError: string | null;
  trackSettings: unknown;
  contextSampleRate: number;
  ttsDurationMs: number;
  playStartedAtMs: number | null;
  /** Near-end (double-talk) playback: start time and duration, when used. */
  nearEndStartedAtMs: number | null;
  nearEndDurationMs: number | null;
  warmupMs: number;
  tailMs: number;
  log: string[];
  /** Page-side copies (base64 LE-s16 @16 kHz) when includePagePcm. */
  pageMicPcm16?: string;
  pagePlayPcm16?: string;
}

export interface AecLoopControl {
  run(options?: AecLoopRunOptions): Promise<AecLoopResult>;
  state(): "idle" | "running" | "done" | "error";
  lastResult(): AecLoopResult | null;
  lastError(): string | null;
  log(): string[];
}

const DEFAULT_TTS_TEXT =
  "Hello, this is the Eliza agent speaking through this device's speaker. " +
  "The acoustic echo canceller should remove this playback from the " +
  "microphone signal before voice activity detection runs. Testing one two " +
  "three four five. The quick brown fox jumps over the lazy dog while the " +
  "agent keeps talking, and the canceller keeps adapting to the room.";

/** Linear-resample Float32 PCM to 16 kHz. */
function resampleTo16k(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === SAMPLE_RATE) return input.slice();
  const outLen = Math.floor((input.length * SAMPLE_RATE) / fromRate);
  const out = new Float32Array(outLen);
  const ratio = fromRate / SAMPLE_RATE;
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac;
  }
  return out;
}

function base64FromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + 8192, bytes.length)),
    );
  }
  return btoa(bin);
}

interface WireFrame {
  pcm16: string;
  sampleRate: number;
  channels: number;
  samples: number;
  rms: number;
  timestamp: number;
  frameIndex: number;
}

/**
 * Accumulates 16 kHz PCM and emits 320-sample wire frames. Timestamps derive
 * from a fixed anchor plus the emitted-sample count, so batch jitter never
 * skews the capture clock.
 */
class WireFramer {
  private anchorMs: number | null = null;
  private pending = new Float32Array(0);
  private emittedSamples = 0;
  private frameIndex = 0;
  private frames: WireFrame[] = [];
  private readonly all: Float32Array[] = [];
  framesEmitted = 0;

  push(pcm16k: Float32Array, nowMs: number, retainCopy: boolean): void {
    if (this.anchorMs === null) {
      this.anchorMs = nowMs - (pcm16k.length / SAMPLE_RATE) * 1000;
    }
    if (retainCopy) this.all.push(pcm16k.slice());
    const merged = new Float32Array(this.pending.length + pcm16k.length);
    merged.set(this.pending, 0);
    merged.set(pcm16k, this.pending.length);
    let off = 0;
    while (off + FRAME_SAMPLES <= merged.length) {
      const slice = merged.subarray(off, off + FRAME_SAMPLES);
      const bytes = new Uint8Array(FRAME_SAMPLES * 2);
      const view = new DataView(bytes.buffer);
      let sum = 0;
      for (let i = 0; i < FRAME_SAMPLES; i += 1) {
        const v = Math.max(-1, Math.min(1, slice[i] ?? 0));
        view.setInt16(i * 2, Math.round(v * 32767), true);
        sum += v * v;
      }
      this.frames.push({
        pcm16: base64FromBytes(bytes),
        sampleRate: SAMPLE_RATE,
        channels: 1,
        samples: FRAME_SAMPLES,
        rms: Math.sqrt(sum / FRAME_SAMPLES),
        timestamp: this.anchorMs + (this.emittedSamples / SAMPLE_RATE) * 1000,
        frameIndex: this.frameIndex,
      });
      this.frameIndex += 1;
      this.framesEmitted += 1;
      this.emittedSamples += FRAME_SAMPLES;
      off += FRAME_SAMPLES;
    }
    this.pending = merged.slice(off);
  }

  take(): WireFrame[] {
    const out = this.frames;
    this.frames = [];
    return out;
  }

  /** All retained 16 kHz PCM as one base64 LE-s16 blob. */
  retainedPcm16Base64(): string {
    let total = 0;
    for (const c of this.all) total += c.length;
    const bytes = new Uint8Array(total * 2);
    const view = new DataView(bytes.buffer);
    let off = 0;
    for (const c of this.all) {
      for (let i = 0; i < c.length; i += 1) {
        const v = Math.max(-1, Math.min(1, c[i] ?? 0));
        view.setInt16((off + i) * 2, Math.round(v * 32767), true);
      }
      off += c.length;
    }
    return base64FromBytes(bytes);
  }
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(resolveApiUrl(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // error-policy:J3 body parse is best-effort context for the thrown error;
  // non-2xx always throws below with the status either way
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(resolveApiUrl(path), {
    headers: { accept: "application/json" },
  });
  // error-policy:J3 body parse is best-effort context for the thrown error;
  // non-2xx always throws below with the status either way
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

/** Best-effort native Documents sink (Capacitor Filesystem when present). */
async function writeResultToDocuments(payload: string): Promise<boolean> {
  const filesystem = (
    window as unknown as {
      Capacitor?: {
        isNativePlatform?: () => boolean;
        Plugins?: {
          Filesystem?: {
            writeFile(options: {
              path: string;
              data: string;
              directory: string;
              encoding: string;
              recursive?: boolean;
            }): Promise<unknown>;
          };
        };
      };
    }
  ).Capacitor;
  const writeFile = filesystem?.Plugins?.Filesystem?.writeFile;
  if (!filesystem?.isNativePlatform?.() || typeof writeFile !== "function") {
    return false;
  }
  await writeFile.call(filesystem.Plugins?.Filesystem, {
    path: RESULT_FILENAME,
    data: payload,
    directory: "DOCUMENTS",
    encoding: "utf8",
  });
  return true;
}

let state: "idle" | "running" | "done" | "error" = "idle";
let lastResult: AecLoopResult | null = null;
let lastError: string | null = null;
let runLog: string[] = [];

async function runAecLoop(
  options: AecLoopRunOptions = {},
): Promise<AecLoopResult> {
  if (state === "running") throw new Error("aec-loop already running");
  state = "running";
  lastError = null;
  runLog = [];
  const log = (msg: string) => {
    runLog.push(`${Math.round(performance.now())} ${msg}`);
  };
  const ttsText = options.ttsText?.trim() || DEFAULT_TTS_TEXT;
  const tailMs = options.tailMs ?? 2000;
  const warmupMs = options.warmupMs ?? 1500;
  const maxSeconds = options.maxSeconds ?? 30;
  const includePagePcm = options.includePagePcm ?? true;
  const tag = options.tag ?? "echo-only";

  let ctx: AudioContext | null = null;
  let track: MediaStreamTrack | null = null;
  try {
    // The deep-link trigger can land while the on-device agent is still
    // booting. A fresh install on a physical device cold-boots the bun agent
    // in ~2.5 min (PGlite migrations, plugin load, native inference init —
    // measured on an iPhone 16 Pro Max), so poll the status route generously
    // rather than giving up at 90 s and losing the whole capture.
    log("status:before");
    let statusBefore: unknown = null;
    const bootDeadline = Date.now() + 300_000;
    for (;;) {
      try {
        statusBefore = await getJson("/api/voice/audio-frames/status");
        break;
      } catch (err) {
        // error-policy:J4 boot poll — retry until the deadline, then rethrow
        if (Date.now() > bootDeadline) throw err;
        log("agent not ready; retrying");
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    log("arm aec-capture");
    await postJson("/api/voice/aec-capture", { arm: true, maxSeconds });

    log("getUserMedia (OS AEC disabled)");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    track = stream.getAudioTracks()[0] ?? null;
    const trackSettings = track?.getSettings ? track.getSettings() : {};

    ctx = new AudioContext();
    await ctx.resume();
    const contextRate = ctx.sampleRate;
    log(`AudioContext rate=${contextRate}`);

    // Mic branch: source → tap → zero gain → destination (the zero gain keeps
    // the tap pulling without re-injecting the mic into the speaker path).
    const micFramer = new WireFramer();
    const micSource = ctx.createMediaStreamSource(stream);
    const micTap = ctx.createScriptProcessor(4096, 1, 1);
    const micMute = ctx.createGain();
    micMute.gain.value = 0;
    micTap.onaudioprocess = (ev) => {
      micFramer.push(
        resampleTo16k(ev.inputBuffer.getChannelData(0), contextRate),
        performance.now(),
        includePagePcm,
      );
    };
    micSource.connect(micTap);
    micTap.connect(micMute);
    micMute.connect(ctx.destination);

    let ttsBytes: ArrayBuffer;
    if (options.audioUrl) {
      log(`fetch far-end audio from ${options.audioUrl}`);
      const audioRes = await fetch(options.audioUrl);
      if (!audioRes.ok) throw new Error(`audioUrl -> ${audioRes.status}`);
      ttsBytes = await audioRes.arrayBuffer();
    } else {
      log("fetch TTS");
      const ttsRes = await fetch(resolveApiUrl("/api/tts/local-inference"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: ttsText }),
      });
      if (!ttsRes.ok) throw new Error(`tts -> ${ttsRes.status}`);
      ttsBytes = await ttsRes.arrayBuffer();
    }
    const ttsBuffer = await ctx.decodeAudioData(ttsBytes.slice(0));
    log(
      `tts decoded ${ttsBuffer.duration.toFixed(2)}s @${ttsBuffer.sampleRate}`,
    );

    // Playback branch: source → tap → destination (the device speaker). The
    // tap sees the RENDERED samples — the live playback-reference producer.
    const playFramer = new WireFramer();
    const source = ctx.createBufferSource();
    source.buffer = ttsBuffer;
    const playTap = ctx.createScriptProcessor(4096, 1, 1);
    playTap.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      ev.outputBuffer.getChannelData(0).set(input);
      playFramer.push(
        resampleTo16k(input, contextRate),
        performance.now(),
        includePagePcm,
      );
    };
    source.connect(playTap);
    playTap.connect(ctx.destination);

    // Near-end (double-talk) branch: same context, straight to destination —
    // deliberately NOT routed through playTap, so this speech reaches the mic
    // acoustically but never enters the far-end reference.
    let nearSource: AudioBufferSourceNode | null = null;
    let nearEndDurationMs: number | null = null;
    if (options.nearEndAudioUrl) {
      log(`fetch near-end audio from ${options.nearEndAudioUrl.slice(0, 64)}`);
      const nearRes = await fetch(options.nearEndAudioUrl);
      if (!nearRes.ok) throw new Error(`nearEndAudioUrl -> ${nearRes.status}`);
      const nearBuffer = await ctx.decodeAudioData(await nearRes.arrayBuffer());
      nearEndDurationMs = Math.round(nearBuffer.duration * 1000);
      nearSource = ctx.createBufferSource();
      nearSource.buffer = nearBuffer;
      nearSource.connect(ctx.destination);
      log(`near-end decoded ${nearBuffer.duration.toFixed(2)}s (un-tapped)`);
    }

    let micPosts = 0;
    let playPosts = 0;
    let shipError: string | null = null;
    const ship = async () => {
      const playFrames = playFramer.take();
      const micFrames = micFramer.take();
      try {
        if (playFrames.length) {
          await postJson("/api/voice/playback-frames", { frames: playFrames });
          playPosts += 1;
        }
        if (micFrames.length) {
          await postJson("/api/voice/audio-frames", { frames: micFrames });
          micPosts += 1;
        }
      } catch (err) {
        // error-policy:J7 frame-ship failure is recorded as shipError in the
        // run result; the loop keeps capturing the remaining evidence
        shipError = String(err);
      }
    };
    const shipTimer = setInterval(() => void ship(), SHIP_INTERVAL_MS);

    log("mic warmup");
    await new Promise((r) => setTimeout(r, warmupMs));

    log("play TTS through device speaker");
    const playStartedAtMs = performance.now();
    const ended = new Promise<void>((resolve) => {
      source.onended = () => resolve();
    });
    source.start(0);
    let nearEndStartedAtMs: number | null = null;
    let nearEnded: Promise<void> = Promise.resolve();
    if (nearSource) {
      log("play near-end (double-talk) speech");
      nearEndStartedAtMs = performance.now();
      nearEnded = new Promise<void>((resolve) => {
        if (nearSource) nearSource.onended = () => resolve();
      });
      nearSource.start(0);
    }
    await Promise.all([ended, nearEnded]);
    log("tts ended; tail");
    await new Promise((r) => setTimeout(r, tailMs));

    clearInterval(shipTimer);
    await ship();
    log("final flush");
    await postJson("/api/voice/audio-frames", { frames: [], flush: true });
    const statusAfter = await getJson("/api/voice/audio-frames/status");
    await postJson("/api/voice/aec-capture", { disarm: true });
    const aecCapture = await getJson("/api/voice/aec-capture");

    track?.stop();
    micTap.disconnect();
    micSource.disconnect();
    playTap.disconnect();
    micMute.disconnect();

    const result: AecLoopResult = {
      tag,
      startedAtIso: new Date().toISOString(),
      userAgent: navigator.userAgent,
      statusBefore,
      statusAfter,
      aecCapture,
      micPosts,
      playPosts,
      micFramesSent: micFramer.framesEmitted,
      playFramesSent: playFramer.framesEmitted,
      shipError,
      trackSettings,
      contextSampleRate: contextRate,
      ttsDurationMs: Math.round(ttsBuffer.duration * 1000),
      playStartedAtMs,
      nearEndStartedAtMs,
      nearEndDurationMs,
      warmupMs,
      tailMs,
      log: runLog,
      ...(includePagePcm
        ? {
            pageMicPcm16: micFramer.retainedPcm16Base64(),
            pagePlayPcm16: playFramer.retainedPcm16Base64(),
          }
        : {}),
    };
    lastResult = result;
    state = "done";
    if (!options.skipFileSink) {
      try {
        const wrote = await writeResultToDocuments(JSON.stringify(result));
        log(wrote ? "result written to Documents" : "no native file sink");
      } catch (err) {
        // error-policy:J6 best-effort Documents sink — the result already
        // lives in lastResult; the failure is logged in the run log
        log(`file sink failed: ${String(err)}`);
      }
    }
    log("done");
    return result;
  } catch (err) {
    // error-policy:J1 harness boundary — record state/lastError for the
    // status API and the Documents sink, then rethrow to the caller
    lastError = err instanceof Error ? (err.stack ?? err.message) : String(err);
    state = "error";
    log(`ERROR ${lastError}`);
    if (!options.skipFileSink) {
      try {
        await writeResultToDocuments(
          JSON.stringify({ tag, error: lastError, log: runLog }),
        );
      } catch {
        // error-policy:J6 best-effort error sink — the error is already
        // surfaced via state/lastError
      }
    }
    throw err;
  } finally {
    track?.stop();
    if (ctx) {
      try {
        await ctx.close();
      } catch {
        // error-policy:J6 teardown — context may already be closed
      }
    }
  }
}

/** Parse `#aec-loop?...` into run options. Returns null for any other hash. */
export function parseAecLoopHash(hash: string): AecLoopRunOptions | null {
  const match = /^#\/?aec-loop(?:\?(.*))?$/.exec(hash);
  if (!match) return null;
  const params = new URLSearchParams(match[1] ?? "");
  const options: AecLoopRunOptions = {};
  const text = params.get("text");
  if (text) options.ttsText = text;
  const audioUrl = params.get("audioUrl");
  if (audioUrl) options.audioUrl = audioUrl;
  const nearUrl = params.get("nearUrl");
  if (nearUrl) options.nearEndAudioUrl = nearUrl;
  const tag = params.get("tag");
  if (tag) options.tag = tag;
  const readNumber = (name: string, min: number): number | null => {
    const value = params.get(name);
    if (value === null || value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= min ? parsed : null;
  };
  const maxSeconds = readNumber("maxSeconds", 1);
  if (maxSeconds !== null) options.maxSeconds = maxSeconds;
  const tailMs = readNumber("tailMs", 0);
  if (tailMs !== null) options.tailMs = tailMs;
  const warmupMs = readNumber("warmupMs", 0);
  if (warmupMs !== null) options.warmupMs = warmupMs;
  if (params.get("pagePcm") === "0") options.includePagePcm = false;
  return options;
}

let installed = false;

/**
 * Attach `window.__aecLoop` and the `#aec-loop?...` hash trigger. Idempotent.
 * The loop never starts without the explicit hash route or a direct
 * `run(...)` call.
 */
export function installAecLoopHarness(): AecLoopControl {
  const control: AecLoopControl = {
    run: runAecLoop,
    state: () => state,
    lastResult: () => lastResult,
    lastError: () => lastError,
    log: () => [...runLog],
  };
  if (installed) {
    window.__aecLoop = control;
    return control;
  }
  installed = true;
  window.__aecLoop = control;

  const maybeRun = () => {
    const options = parseAecLoopHash(window.location.hash);
    if (!options || state === "running") return;
    void runAecLoop(options).catch(() => {
      // error-policy:J5 rejection observed via state()/lastError() and the
      // Documents sink written inside runAecLoop
    });
  };
  window.addEventListener("hashchange", maybeRun);
  maybeRun();
  return control;
}
