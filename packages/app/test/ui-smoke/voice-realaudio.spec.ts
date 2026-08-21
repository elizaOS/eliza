/**
 * REAL-AUDIO, button-press voice e2e — runs in the `chromium-voice-mic` project
 * (Chromium launched with --use-file-for-fake-audio-capture=known-phrase.wav).
 *
 * Unlike the shimmed STT in tts-stt-e2e.spec.ts, this drives the REAL capture
 * path: a user PRESSES the mic button -> getUserMedia opens the (fake) device
 * -> startLocalAsrRecorder records + WAV-encodes the injected audio -> POST
 * /api/asr/local-inference -> real SSE reply -> real TTS fetch + decodeAudioData.
 * The ASR/agent/TTS BACKENDS are mocked (not provisioned in CI); the AUDIO IN
 * and every client step are real. No human, no microphone.
 *
 * The trailing `test.describe` block (#14371) adds the failure-path coverage a
 * real user hits — mic-permission denied, silence/empty capture, and a TTS
 * fetch dropped mid-stream — asserting a distinguishable error/degrade render
 * (three-state rule, never healthy-empty) in the same keyless fake-mic lane, plus
 * an opt-in LIVE web round-trip (gated on ELIZA_VOICE_LIVE_RAILWAY=1) that drops
 * every mock and drives the real cloud STT proxy (`/api/asr/cloud` → Railway
 * Whisper) → live agent → cloud Kokoro TTS (`/api/tts/cloud`), asserting a
 * transcript match and decoded NON-silent audio out. The live variant SKIPS
 * (never green) when ungated; the failure paths always run.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-realaudio.spec.ts
 */
import { expect, type Page, type Response, test } from "@playwright/test";
import { KNOWN_PHRASE_WAV_DATA_URL } from "../../../ui/src/voice/voice-selftest/fixtures/known-phrase";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { seedStewardSession } from "./helpers/test-auth";
import { selectVoiceTrajectory } from "./voice-live-trajectory";

const EXPECTED_PHRASE = "what time is it";
const CHAT_CONVERSATION_ID = "voice-realaudio-convo";
const CHAT_ROOM_ID = "voice-realaudio-room";
const SPOKEN_REPLY =
  "It is exactly noon in the real audio barge in test. I am still speaking this long local inference response so the user can interrupt me with the microphone.";

interface AudioProbeEvent {
  type: "start" | "stop" | "disconnect" | "ended";
  id: number;
  at: number;
}

interface AudioProbeSnapshot {
  starts: number;
  stops: number;
  disconnects: number;
  ended: number;
  events: AudioProbeEvent[];
}

function tinyWav(seconds = 0.2, sampleRate = 16000): Buffer {
  const n = Math.floor(sampleRate * seconds);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    pcm.writeInt16LE(
      Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / sampleRate)),
      i * 2,
    );
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function appConfigWithLocalVoice(): Record<string, unknown> {
  return {
    meta: { firstRunComplete: true },
    agents: {
      list: [
        {
          id: "ui-smoke-agent",
          name: "Playwright Smoke",
          status: "running",
        },
      ],
      defaults: {
        workspace: "ui-smoke-workspace",
        adminEntityId: "owner-ui-smoke",
      },
    },
    messages: {
      tts: {
        provider: "local-inference",
        asr: { provider: "local-inference" },
      },
    },
  };
}

async function installLocalVoiceConfig(page: Page): Promise<void> {
  await page.unroute("**/api/status").catch(() => {});
  await page.route("**/api/status**", async (route) => {
    if (route.request().method() !== "GET") {
      return route.fallback();
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: "running",
        agentName: "Playwright Smoke",
        model: "ui-smoke",
        canRespond: true,
        startedAt: Date.now() - 60_000,
        uptime: 60_000,
      }),
    });
  });

  await page.unroute("**/api/config").catch(() => {});
  await page.route("**/api/config", async (route) => {
    if (!["GET", "PATCH", "PUT"].includes(route.request().method())) {
      return route.fallback();
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(appConfigWithLocalVoice()),
    });
  });
}

async function installAudioSourceProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type ProbeEvent = {
      type: "start" | "stop" | "disconnect" | "ended";
      id: number;
      at: number;
    };
    type Probe = {
      starts: number;
      stops: number;
      disconnects: number;
      ended: number;
      events: ProbeEvent[];
    };
    type ProbeWindow = Window & {
      __voiceAudioProbe?: Probe;
      __voiceAudioProbeInstalled?: boolean;
      webkitAudioContext?: typeof AudioContext;
    };
    const w = window as ProbeWindow;
    if (w.__voiceAudioProbeInstalled) return;
    w.__voiceAudioProbeInstalled = true;
    const probe: Probe = {
      starts: 0,
      stops: 0,
      disconnects: 0,
      ended: 0,
      events: [],
    };
    w.__voiceAudioProbe = probe;
    let nextId = 0;

    const patch = (Ctor: typeof AudioContext | undefined) => {
      const proto = Ctor?.prototype as
        | (AudioContext & { __elizaVoiceAudioProbePatched?: boolean })
        | undefined;
      if (!proto || proto.__elizaVoiceAudioProbePatched) return;
      proto.__elizaVoiceAudioProbePatched = true;
      const originalCreateBufferSource = proto.createBufferSource;
      proto.createBufferSource = function createBufferSourceWithProbe() {
        const source = originalCreateBufferSource.call(this);
        nextId += 1;
        const id = nextId;
        const originalStart = source.start.bind(source) as (
          ...args: unknown[]
        ) => void;
        const originalStop = source.stop.bind(source) as (
          ...args: unknown[]
        ) => void;
        const originalDisconnect = source.disconnect.bind(source) as (
          ...args: unknown[]
        ) => void;

        source.start = ((...args: unknown[]) => {
          probe.starts += 1;
          probe.events.push({ type: "start", id, at: Date.now() });
          return originalStart(...args);
        }) as AudioBufferSourceNode["start"];
        source.stop = ((...args: unknown[]) => {
          probe.stops += 1;
          probe.events.push({ type: "stop", id, at: Date.now() });
          return originalStop(...args);
        }) as AudioBufferSourceNode["stop"];
        source.disconnect = ((...args: unknown[]) => {
          probe.disconnects += 1;
          probe.events.push({
            type: "disconnect",
            id,
            at: Date.now(),
          });
          return originalDisconnect(...args);
        }) as AudioBufferSourceNode["disconnect"];
        source.addEventListener("ended", () => {
          probe.ended += 1;
          probe.events.push({ type: "ended", id, at: Date.now() });
        });
        return source;
      };
    };

    patch(w.AudioContext);
    patch(w.webkitAudioContext);
  });
}

async function readAudioProbe(page: Page): Promise<AudioProbeSnapshot> {
  return page.evaluate(() => {
    const probe = (
      window as Window & {
        __voiceAudioProbe?: AudioProbeSnapshot;
      }
    ).__voiceAudioProbe;
    return (
      probe ?? {
        starts: 0,
        stops: 0,
        disconnects: 0,
        ended: 0,
        events: [],
      }
    );
  });
}

async function dispatchVoiceControl(
  page: Page,
  command: "start" | "stop",
): Promise<void> {
  await page.evaluate((nextCommand) => {
    window.dispatchEvent(
      new CustomEvent("eliza:voice-control", {
        detail: { command: nextCommand },
      }),
    );
  }, command);
}

async function installVoiceBackendMocks(page: Page): Promise<void> {
  let conversationCreated = false;
  const messages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    timestamp: number;
  }> = [];

  await page.route("**/api/asr/local-inference/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ready: true, provider: "local-inference" }),
    });
  });
  await page.route("**/api/asr/local-inference", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    // The recorder must have actually POSTed a non-trivial captured WAV.
    const body = route.request().postDataBuffer();
    const bytes = body?.byteLength ?? 0;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        text: bytes > 1000 ? EXPECTED_PHRASE : "",
        capturedBytes: bytes,
      }),
    });
  });
  await page.route("**/api/conversations", async (route) => {
    const timestamp = new Date().toISOString();
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversations: conversationCreated
            ? [
                {
                  id: CHAT_CONVERSATION_ID,
                  roomId: CHAT_ROOM_ID,
                  title: "Real audio chat",
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
              ]
            : [],
        }),
      });
      return;
    }
    if (route.request().method() !== "POST") return route.fallback();
    conversationCreated = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversation: {
          id: CHAT_CONVERSATION_ID,
          roomId: CHAT_ROOM_ID,
          title: "Real audio chat",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      }),
    });
  });
  await page.route(
    `**/api/conversations/${CHAT_CONVERSATION_ID}/messages`,
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ messages }),
      });
    },
  );
  await page.route(
    `**/api/conversations/${CHAT_CONVERSATION_ID}/messages/stream`,
    async (route) => {
      const reqBody = JSON.parse(route.request().postData() ?? "{}") as {
        text?: string;
      };
      const now = Date.now();
      messages.push({
        id: `real-audio-user-${messages.length + 1}`,
        role: "user",
        text: reqBody.text?.trim() || EXPECTED_PHRASE,
        timestamp: now,
      });
      messages.push({
        id: `real-audio-assistant-${messages.length + 1}`,
        role: "assistant",
        text: SPOKEN_REPLY,
        timestamp: now + 1,
      });
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `data: ${JSON.stringify({ type: "token", text: SPOKEN_REPLY, fullText: SPOKEN_REPLY })}\n\n` +
          `data: ${JSON.stringify({ type: "done", fullText: SPOKEN_REPLY, agentName: "Eliza" })}\n\n`,
      });
    },
  );
  await page.route(
    `**/api/conversations/${CHAT_CONVERSATION_ID}/greeting**`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          text: "Ready for real audio.",
          localInference: null,
        }),
      });
    },
  );
  await page.route(
    `**/api/conversations/${CHAT_CONVERSATION_ID}`,
    async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      const timestamp = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversation: {
            id: CHAT_CONVERSATION_ID,
            roomId: CHAT_ROOM_ID,
            title: "Real audio chat",
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        }),
      });
    },
  );
  await page.route(`**/api/turns/${CHAT_ROOM_ID}/abort`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        aborted: true,
        roomId: CHAT_ROOM_ID,
        reason: "ui-chat-abort",
      }),
    });
  });
  await page.route("**/api/voice/playback-frames", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  const wav = tinyWav();
  const longWav = tinyWav(8);
  for (const r of ["**/api/tts/cloud", "**/api/tts/local-inference"]) {
    await page.route(r, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({
        status: 200,
        headers: { "content-type": "audio/wav" },
        body: route.request().url().includes("/api/tts/local-inference")
          ? longWav
          : wav,
      });
    });
  }
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  // The production web bundle this lane serves brands itself cloud-only, and
  // the shell auth gate (#20483) silently parks every mic engagement behind
  // Cloud sign-in when no usable Steward session exists — turning each tap
  // into a dead no-op long before getUserMedia runs. These cells assert the
  // signed-in voice pipeline, so seed the canonical session up front.
  await seedStewardSession(page);
  await installDefaultAppRoutes(page);
  await installVoiceBackendMocks(page);
});

test("pressing the mic button captures REAL injected audio and completes the voice round-trip", async ({
  page,
}) => {
  let asrPosted = 0;
  page.on("request", (req) => {
    if (
      req.method() === "POST" &&
      req.url().includes("/api/asr/local-inference") &&
      !req.url().includes("/status")
    ) {
      asrPosted += 1;
    }
  });

  await page.goto("/?shellMode=voice-selftest", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("voice-selftest-shell")).toBeVisible({
    timeout: 30_000,
  });

  const readReport = () =>
    page.evaluate(
      () =>
        JSON.parse(
          document.querySelector('[data-testid="voice-selftest-report"]')
            ?.textContent ?? "{}",
        ) as {
          mode?: string;
          overall?: string;
          stages?: Array<{
            stage: string;
            status: string;
            detail?: Record<string, unknown>;
          }>;
        },
    );

  // PRESS THE BUTTON: the mic-capture run opens the real (fake) device, records,
  // WAV-encodes, and POSTs the captured audio — the literal voice-in path. The
  // screen also auto-runs `wav-direct` on mount, so poll for the MIC-CAPTURE
  // report specifically (the capture window takes a few seconds to drain).
  await page.getByTestId("voice-selftest-run-mic").click();
  await expect
    .poll(
      async () => {
        const r = await readReport();
        return r.mode === "mic-capture" ? r.overall : null;
      },
      { timeout: 30_000 },
    )
    .toBe("pass");

  // Prove the capture path actually ran: a real WAV was POSTed to ASR.
  expect(
    asrPosted,
    "mic capture must POST a recorded WAV to ASR",
  ).toBeGreaterThan(0);

  const report = await readReport();
  expect(report.mode).toBe("mic-capture");
  const asr = report.stages?.find((s) => s.stage === "asr");
  expect(asr?.status).toBe("pass");
  // NOTE: this Chromium lane runs against a MOCK ASR that echoes the expected
  // phrase, so a WER assertion here would be structurally 0 and could never
  // catch a regression (#10726). The load-bearing proof in this lane is that a
  // real captured WAV reached ASR (asrPosted above). WER accuracy is scored only
  // in the tiers with a REAL recognizer — plugin-local-inference *.real.test.ts
  // and the voice:matrix hardware lanes — not against the echo mock.
});

test("REAL audio: transcription start during spoken local TTS barges in and silences playback", async ({
  page,
}) => {
  await installLocalVoiceConfig(page);
  await installAudioSourceProbe(page);

  const asrPosts: number[] = [];
  page.on("request", (req) => {
    if (
      req.method() === "POST" &&
      req.url().includes("/api/asr/local-inference") &&
      !req.url().includes("/status")
    ) {
      asrPosts.push(req.postDataBuffer()?.byteLength ?? 0);
    }
  });

  await openAppPath(page, "/chat");
  await expect(page.getByTestId("chat-overlay")).toBeVisible({
    timeout: 30_000,
  });
  const mic = page.getByTestId("chat-composer-mic");
  await expect(mic).toHaveAttribute("aria-label", "talk", {
    timeout: 15_000,
  });

  // First drive a real fake-device voice turn so the next assistant message is
  // genuinely voice-originated and therefore spoken aloud by the shell.
  await mic.click();
  await expect(mic).toHaveAttribute("aria-label", "end conversation", {
    timeout: 15_000,
  });
  await page.waitForTimeout(1500);
  await mic.click();

  await expect
    .poll(() => asrPosts.length, {
      timeout: 25_000,
      message: "stopping the first voice turn must POST captured WAV to ASR",
    })
    .toBeGreaterThanOrEqual(1);

  await expect
    .poll(async () => (await readAudioProbe(page)).starts, {
      timeout: 25_000,
      message: "assistant local TTS must start real Web Audio playback",
    })
    .toBeGreaterThan(0);

  const beforeBarge = await readAudioProbe(page);

  // This is the same window event used by the agent-action bridge for
  // START_TRANSCRIPTION. It opens the real local-ASR capture while the long TTS
  // clip is still playing; the shell's recording-driven barge-in effect must
  // silence the in-flight Web Audio source immediately.
  await dispatchVoiceControl(page, "start");
  await expect(
    page.getByTestId("chat-composer-transcription-stop"),
  ).toHaveAttribute("aria-label", "stop transcription", {
    timeout: 15_000,
  });
  await expect
    .poll(
      async () => {
        const probe = await readAudioProbe(page);
        return probe.disconnects + probe.stops;
      },
      {
        timeout: 10_000,
        message:
          "starting transcription during TTS must disconnect/stop the active audio source",
      },
    )
    .toBeGreaterThan(beforeBarge.disconnects + beforeBarge.stops);

  await page.waitForTimeout(1200);
  await dispatchVoiceControl(page, "stop");
  await expect
    .poll(() => asrPosts.length, {
      timeout: 25_000,
      message:
        "the barge-in transcription capture must also drain a real WAV to ASR",
    })
    .toBeGreaterThanOrEqual(2);
  expect(Math.min(...asrPosts)).toBeGreaterThan(1000);
});

// Failure paths the mocked front-door tests above never exercise (#14371). Each
// runs in the SAME keyless fake-mic Chromium lane and asserts a distinguishable
// error/degrade render — the three-state rule forbids a failure that reads as a
// healthy empty result (a silent no-op mic, a phantom send, a hung player).
const CLOUD_CONVERSATION_ID = "voice-live-convo";

function appConfigWithCloudVoice(): Record<string, unknown> {
  const base = appConfigWithLocalVoice() as {
    messages: { tts: { provider: string; asr: { provider: string } } };
  };
  // Web/cloud default: Eliza Cloud Kokoro TTS (`/api/tts/cloud`) + Eliza Cloud
  // ASR, whose interactive web capture records a WAV and POSTs it to the cloud
  // STT proxy (`/api/asr/cloud` → Railway Whisper). See voice-provider-defaults.
  base.messages.tts.provider = "eliza-cloud";
  base.messages.tts.asr.provider = "eliza-cloud";
  return base;
}

async function installCloudVoiceConfig(page: Page): Promise<void> {
  await page.unroute("**/api/status").catch(() => {});
  await page.route("**/api/status**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: "running",
        agentName: "Playwright Smoke",
        model: "ui-smoke",
        canRespond: true,
        startedAt: Date.now() - 60_000,
        uptime: 60_000,
      }),
    });
  });
  await page.unroute("**/api/config").catch(() => {});
  await page.route("**/api/config", async (route) => {
    if (!["GET", "PATCH", "PUT"].includes(route.request().method())) {
      return route.fallback();
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(appConfigWithCloudVoice()),
    });
  });
}

async function describeVoiceRouteFailure(response: Response): Promise<string> {
  // error-policy:J6 diagnostic capture — the live assertion remains the
  // failure authority. Only structured error/message text is retained;
  // arbitrary response bodies and credential-shaped values stay out of logs.
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    message?: unknown;
  } | null;
  const detail =
    typeof body?.error === "string"
      ? body.error
      : typeof body?.message === "string"
        ? body.message
        : "<structured error body unavailable>";
  const preview = detail
    .replace(/\s+/g, " ")
    .replace(/\b(?:eliza|sk)_[a-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .slice(0, 500);
  return `${new URL(response.url()).pathname} HTTP ${response.status()}: ${preview}`;
}

/** Count POSTs to a client route (ignoring the `/status` probe siblings). */
function countPosts(page: Page, needle: string): { get: () => number } {
  let n = 0;
  page.on("request", (req) => {
    if (
      req.method() === "POST" &&
      req.url().includes(needle) &&
      !req.url().includes("/status")
    ) {
      n += 1;
    }
  });
  return { get: () => n };
}

/** Parse a WAV buffer and report duration + whether any sample is non-silent. */
function inspectWav(bytes: Buffer): {
  isWav: boolean;
  durationMs: number;
  peak: number;
} {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF") {
    return { isWav: false, durationMs: 0, peak: 0 };
  }
  const sampleRate = bytes.readUInt32LE(24);
  const channels = bytes.readUInt16LE(22) || 1;
  const bitsPerSample = bytes.readUInt16LE(34) || 16;
  const bytesPerSample = bitsPerSample / 8;
  let dataOffset = 12;
  let dataLen = 0;
  while (dataOffset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", dataOffset, dataOffset + 4);
    const size = bytes.readUInt32LE(dataOffset + 4);
    if (id === "data") {
      dataOffset += 8;
      dataLen = Math.min(size, bytes.length - dataOffset);
      break;
    }
    dataOffset += 8 + size;
  }
  let peak = 0;
  if (bitsPerSample === 16) {
    for (let i = dataOffset; i + 1 < dataOffset + dataLen; i += 2) {
      peak = Math.max(peak, Math.abs(bytes.readInt16LE(i)));
    }
  }
  const frames = dataLen / (bytesPerSample * channels);
  return {
    isWav: true,
    durationMs: sampleRate ? Math.round((frames / sampleRate) * 1000) : 0,
    peak,
  };
}

test.describe("voice failure paths (keyless)", () => {
  test("mic permission denied surfaces a distinguishable error and starts NO phantom capture", async ({
    page,
  }) => {
    await installLocalVoiceConfig(page);
    // Deny the device before any app script runs: the real capture path calls
    // navigator.mediaDevices.getUserMedia, so a rejected promise here drives the
    // genuine NotAllowedError client path (the fake-audio device would otherwise
    // grant the mic in this lane).
    await page.addInitScript(() => {
      const md = navigator.mediaDevices;
      if (md) {
        md.getUserMedia = () =>
          Promise.reject(
            new DOMException("Permission denied", "NotAllowedError"),
          );
      }
    });
    const asrPosts = countPosts(page, "/api/asr/local-inference");

    await openAppPath(page, "/chat");
    await expect(page.getByTestId("chat-overlay")).toBeVisible({
      timeout: 30_000,
    });
    const mic = page.getByTestId("chat-composer-mic");
    await expect(mic).toHaveAttribute("aria-label", "talk", {
      timeout: 15_000,
    });

    await mic.click();

    // The denial must render a visible, error-toned notice — not a silent mic.
    const notice = page.getByTestId("shell-action-notice");
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toHaveAttribute("data-tone", "error");
    await expect(notice).toContainText("Microphone access was denied");

    // No phantom capture: the mic must roll back to its resting "talk" label
    // (not stay lit as an "end conversation" the device never opened) and no
    // WAV may reach ASR because recording never started.
    await expect(mic).toHaveAttribute("aria-label", "talk", {
      timeout: 15_000,
    });
    await page.waitForTimeout(1500);
    expect(asrPosts.get(), "a denied mic must POST no captured audio").toBe(0);
  });

  test("silent/empty capture sends NO message and returns to rest (no phantom send)", async ({
    page,
  }) => {
    await installLocalVoiceConfig(page);
    // Silence transcribes to an empty string; the local-inference transcribe
    // helper treats that as a typed-invalid result and throws, so the turn must
    // be dropped — never sent as an empty user message. Override the phrase-echo
    // mock to return the empty transcript a silent clip produces.
    await page.unroute("**/api/asr/local-inference").catch(() => {});
    await page.route("**/api/asr/local-inference", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const bytes = route.request().postDataBuffer()?.byteLength ?? 0;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ text: "", capturedBytes: bytes }),
      });
    });
    const streamPosts = countPosts(
      page,
      `/api/conversations/${CHAT_CONVERSATION_ID}/messages/stream`,
    );

    await openAppPath(page, "/chat");
    await expect(page.getByTestId("chat-overlay")).toBeVisible({
      timeout: 30_000,
    });
    const mic = page.getByTestId("chat-composer-mic");
    await expect(mic).toHaveAttribute("aria-label", "talk", {
      timeout: 15_000,
    });

    // Drive a real fake-device converse turn that transcribes to nothing.
    await mic.click();
    await expect(mic).toHaveAttribute("aria-label", "end conversation", {
      timeout: 15_000,
    });
    await page.waitForTimeout(2000);
    await mic.click();
    await expect(mic).toHaveAttribute("aria-label", "talk", {
      timeout: 15_000,
    });

    // An empty transcription may never become a sent turn, and no user bubble
    // may appear for the silence.
    await page.waitForTimeout(1500);
    expect(
      streamPosts.get(),
      "a silent/empty turn must not POST a message",
    ).toBe(0);
    await expect(
      page.locator('[data-testid^="chat-message-user"]'),
    ).toHaveCount(0);
  });

  test("TTS dropped mid-stream fails closed (no hung playback) and the next turn still speaks", async ({
    page,
  }) => {
    await installLocalVoiceConfig(page);
    await installAudioSourceProbe(page);

    // Turn 1 drops the TTS connection; turn 2 restores it. A dropped fetch is a
    // real network error (not a user-cancel AbortError), so it must fail closed
    // — the queue drains, speaking clears, and nothing keeps playing.
    let dropTts = true;
    let ttsAttempts = 0;
    for (const r of ["**/api/tts/cloud", "**/api/tts/local-inference"]) {
      await page.unroute(r).catch(() => {});
      await page.route(r, async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        ttsAttempts += 1;
        if (dropTts) return route.abort("connectionaborted");
        await route.fulfill({
          status: 200,
          headers: { "content-type": "audio/wav" },
          body: tinyWav(8),
        });
      });
    }

    await openAppPath(page, "/chat");
    await expect(page.getByTestId("chat-overlay")).toBeVisible({
      timeout: 30_000,
    });
    const mic = page.getByTestId("chat-composer-mic");
    await expect(mic).toHaveAttribute("aria-label", "talk", {
      timeout: 15_000,
    });

    // Turn 1: a voice-originated reply is spoken, but its TTS fetch is dropped.
    await mic.click();
    await expect(mic).toHaveAttribute("aria-label", "end conversation", {
      timeout: 15_000,
    });
    await page.waitForTimeout(1500);
    await mic.click();
    await expect(mic).toHaveAttribute("aria-label", "talk", {
      timeout: 15_000,
    });

    await expect
      .poll(() => ttsAttempts, {
        timeout: 25_000,
        message: "the spoken reply must attempt a TTS fetch",
      })
      .toBeGreaterThanOrEqual(1);
    // The dropped fetch must not have produced hung playback: no Web Audio
    // source ever started for the failed turn.
    await page.waitForTimeout(1500);
    const afterDrop = await readAudioProbe(page);
    expect(
      afterDrop.starts,
      "a dropped TTS fetch must not start audio playback",
    ).toBe(0);

    // Turn 2: TTS restored — the pipeline must recover and actually speak.
    dropTts = false;
    await mic.click();
    await expect(mic).toHaveAttribute("aria-label", "end conversation", {
      timeout: 15_000,
    });
    await page.waitForTimeout(1500);
    await mic.click();

    await expect
      .poll(async () => (await readAudioProbe(page)).starts, {
        timeout: 25_000,
        message: "after a TTS failure the next turn must resume playback",
      })
      .toBeGreaterThan(0);
  });
});

// Opt-in LIVE web round-trip against the REAL cloud voice pipeline (#14371).
// Gated on ELIZA_VOICE_LIVE_RAILWAY=1 with reachable Railway STT/TTS + a live
// LLM key; it drops every backend mock so the injected known-phrase WAV flows
// mic → cloud STT proxy (`/api/asr/cloud` → Whisper) → live agent → cloud Kokoro
// TTS (`/api/tts/cloud`) → decoded, non-silent audio out. SKIPPED (never green)
// when ungated so an unprovisioned lane can never masquerade as passing.
const LIVE_RAILWAY = process.env.ELIZA_VOICE_LIVE_RAILWAY === "1";

test.describe("live cloud voice round-trip (Railway path)", () => {
  test.skip(
    !LIVE_RAILWAY,
    "set ELIZA_VOICE_LIVE_RAILWAY=1 with reachable Railway STT/TTS + a live LLM key",
  );

  test("injected known-phrase WAV round-trips through real cloud STT → agent → cloud TTS", async ({
    page,
  }, testInfo) => {
    await installCloudVoiceConfig(page);
    await installAudioSourceProbe(page);
    // Tee the live SSE stream inside the page: CDP's Network.getResponseBody
    // cannot return a consumed streaming body ("No data found for resource"),
    // so Playwright's response.body() is structurally unavailable for the
    // real /messages/stream turn. A fetch wrapper clones matching responses
    // and buffers their text for the assertions below.
    await page.addInitScript(() => {
      const captures: Array<{
        url: string;
        status: number;
        text: string;
        done: boolean;
      }> = [];
      (
        window as unknown as { __voiceStreamCaptures: typeof captures }
      ).__voiceStreamCaptures = captures;
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        try {
          const rawUrl =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          const method = (
            init?.method ??
            (input instanceof Request ? input.method : "GET")
          ).toUpperCase();
          const resolved = new URL(rawUrl, window.location.href);
          if (
            method === "POST" &&
            /\/api\/conversations\/[^/]+\/messages\/stream$/.test(
              resolved.pathname,
            )
          ) {
            const entry = {
              url: resolved.href,
              status: response.status,
              text: "",
              done: false,
            };
            captures.push(entry);
            void response
              .clone()
              .text()
              .then((text) => {
                entry.text = text;
                entry.done = true;
              })
              .catch(() => {
                entry.done = true;
              });
          }
        } catch {
          // error-policy:J6 diagnostic tee only — the product fetch result is
          // returned untouched; a capture failure surfaces as the assertion
          // below finding no completed stream capture.
        }
        return response;
      };
    });

    // Drop the mocks the shared beforeEach installed so these reach the live
    // stack (which proxies to the real cloud STT/TTS + runs a live agent turn).
    for (const r of [
      "**/api/asr/cloud",
      "**/api/tts/cloud",
      "**/api/conversations",
      `**/api/conversations/${CLOUD_CONVERSATION_ID}/messages/stream`,
      `**/api/conversations/${CHAT_CONVERSATION_ID}/messages/stream`,
    ]) {
      await page.unroute(r).catch(() => {});
    }

    const startedAt = Date.now();
    let capturedMicWav: Buffer | null = null;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().includes("/api/asr/cloud")
      ) {
        capturedMicWav = request.postDataBuffer();
      }
    });
    const asrResponsePromise = page.waitForResponse(
      // The product client deliberately retries the deferred runtime's
      // `feature_starting` 503. Observe the settled request rather than
      // treating the first readiness probe as the transcription result.
      (response) =>
        response.url().includes("/api/asr/cloud") && response.status() !== 503,
      { timeout: 60_000 },
    );
    // Register every response observer before starting capture. On a fast live
    // stack the SSE and TTS requests can complete between the mic-stop click
    // and the next statement; attaching waiters afterward turns a healthy run
    // into a timeout and, worse, loses the response bytes needed for evidence.
    const streamResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/messages/stream") &&
        response.request().method() === "POST",
      { timeout: 120_000 },
    );
    const ttsResponses: Response[] = [];
    page.on("response", (response) => {
      if (response.url().includes("/api/tts/cloud"))
        ttsResponses.push(response);
    });

    await openAppPath(page, "/chat");
    await expect(page.getByTestId("chat-overlay")).toBeVisible({
      timeout: 30_000,
    });
    const mic = page.getByTestId("chat-composer-mic");
    await expect(mic).toHaveAttribute("aria-label", "talk", {
      timeout: 15_000,
    });

    // Put the exact injected phrase on the browser's real audio-output graph
    // before capture. CI records the system sink monitor, so its audio artifact
    // contains the audible input reference followed by the actual product TTS
    // playback; it is not a post-hoc payload concatenation.
    const referenceOutput = await page.evaluate(async (source) => {
      // The app's CSP allows `blob:` media but not `data:` URIs, so decode the
      // fixture in-page and play an object URL — a raw `new Audio(dataUrl)`
      // is blocked by media-src and fires the error event before playback.
      const base64 = source.slice(source.indexOf(",") + 1);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const objectUrl = URL.createObjectURL(
        new Blob([bytes], { type: "audio/wav" }),
      );
      const audio = new Audio(objectUrl);
      const startedAt = new Date().toISOString();
      try {
        await new Promise<void>((resolve, reject) => {
          audio.addEventListener("ended", () => resolve(), { once: true });
          audio.addEventListener(
            "error",
            () => reject(new Error("known-phrase output playback failed")),
            { once: true },
          );
          void audio.play().catch(reject);
        });
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      return { startedAt, endedAt: new Date().toISOString() };
    }, KNOWN_PHRASE_WAV_DATA_URL);
    const ttsProbeBaseline = (await readAudioProbe(page)).starts;

    await mic.click();
    await expect(mic).toHaveAttribute("aria-label", "end conversation", {
      timeout: 15_000,
    });
    await page.waitForTimeout(2500);
    await mic.click();

    const asrResponse = await asrResponsePromise;
    expect(asrResponse.ok(), await describeVoiceRouteFailure(asrResponse)).toBe(
      true,
    );
    const asrJson = (await asrResponse.json()) as { text?: unknown };
    const asrTranscript = typeof asrJson.text === "string" ? asrJson.text : "";
    expect(
      asrTranscript.toLowerCase(),
      "cloud STT must transcribe the injected known phrase",
    ).toContain("time");

    const streamResponse = await streamResponsePromise;
    expect(
      streamResponse.ok(),
      await describeVoiceRouteFailure(streamResponse),
    ).toBe(true);
    const streamUrl = streamResponse.url();
    await expect
      .poll(
        () =>
          page.evaluate((url) => {
            const captures = (
              window as unknown as {
                __voiceStreamCaptures?: Array<{
                  url: string;
                  done: boolean;
                }>;
              }
            ).__voiceStreamCaptures;
            return Boolean(
              captures?.some((entry) => entry.url === url && entry.done),
            );
          }, streamUrl),
        {
          timeout: 30_000,
          message:
            "the in-page tee must finish buffering the live SSE stream body",
        },
      )
      .toBe(true);
    const streamText = await page.evaluate((url) => {
      const captures = (
        window as unknown as {
          __voiceStreamCaptures?: Array<{
            url: string;
            done: boolean;
            text: string;
          }>;
        }
      ).__voiceStreamCaptures;
      return (
        captures?.find((entry) => entry.url === url && entry.done)?.text ?? ""
      );
    }, streamUrl);
    const streamDone = streamText
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => {
        try {
          return JSON.parse(line.slice(5).trim()) as {
            type?: unknown;
            messageId?: unknown;
            userMessageId?: unknown;
            fullText?: unknown;
          };
        } catch {
          // error-policy:J3 the SSE stream is untrusted response data; invalid
          // lines are excluded and the required done/message id fails below.
          return null;
        }
      })
      .find((event) => event?.type === "done");
    expect(
      streamDone?.messageId,
      "the live stream must return its persisted assistant message id",
    ).toEqual(expect.any(String));
    expect(
      streamDone?.userMessageId,
      "the live stream must return the persisted user message id used by trajectory metadata",
    ).toEqual(expect.any(String));
    const conversationId = new URL(streamResponse.url()).pathname.match(
      /\/api\/conversations\/([^/]+)\/messages\/stream$/,
    )?.[1];
    expect(conversationId).toEqual(expect.any(String));
    expect(streamDone?.fullText).toEqual(expect.any(String));
    const conversationsResponse = await page.request.get("/api/conversations");
    expect(conversationsResponse.ok()).toBe(true);
    const conversationsPayload = (await conversationsResponse.json()) as {
      conversations?: Array<{ id?: unknown; roomId?: unknown }>;
    };
    const conversation = conversationsPayload.conversations?.find(
      (candidate) =>
        candidate.id === decodeURIComponent(String(conversationId)),
    );
    expect(
      conversation?.roomId,
      "the live conversation must expose the room used for trajectory correlation",
    ).toEqual(expect.any(String));

    // Real cloud TTS returned decoded, non-silent audio that actually played.
    const responseMatchesVoiceReply = (response: Response) => {
      try {
        const body = JSON.parse(response.request().postData() ?? "{}") as {
          text?: unknown;
        };
        return body.text === streamDone?.fullText;
      } catch {
        // error-policy:J3 captured request bodies are untrusted input;
        // malformed candidates cannot match the exact completed turn.
        return false;
      }
    };
    await expect
      .poll(() => ttsResponses.some(responseMatchesVoiceReply), {
        timeout: 120_000,
        message: "cloud TTS must synthesize the exact persisted voice reply",
      })
      .toBe(true);
    const ttsResponse = ttsResponses.find(responseMatchesVoiceReply);
    expect(ttsResponse).toBeDefined();
    if (!ttsResponse) return;
    expect(ttsResponse.ok(), await describeVoiceRouteFailure(ttsResponse)).toBe(
      true,
    );
    const ttsContentType = ttsResponse.headers()["content-type"] ?? "";
    const ttsAudio = await ttsResponse.body();
    const ttsBytes = ttsAudio.byteLength;
    expect(
      ttsBytes,
      "cloud TTS must return a non-trivial audio body",
    ).toBeGreaterThan(2000);
    expect(ttsContentType).toContain("audio");
    const ttsExtension = ttsContentType.includes("mpeg") ? "mp3" : "wav";
    await testInfo.attach(`voice-live-tts.${ttsExtension}`, {
      body: ttsAudio,
      contentType: ttsContentType,
    });
    expect(
      capturedMicWav?.byteLength,
      "the live lane must retain the exact browser-captured mic WAV",
    ).toBeGreaterThan(1000);
    await testInfo.attach("voice-live-input.wav", {
      body: capturedMicWav as Buffer,
      contentType: "audio/wav",
    });
    await expect
      .poll(async () => (await readAudioProbe(page)).starts, {
        timeout: 30_000,
        message: "the decoded cloud TTS audio must start real playback",
      })
      .toBeGreaterThan(ttsProbeBaseline);
    const ttsStartEvent = (await readAudioProbe(page)).events.filter(
      (event) => event.type === "start",
    )[ttsProbeBaseline];
    expect(
      ttsStartEvent?.at,
      "the product TTS playback must expose its exact AudioBufferSource start time",
    ).toBeGreaterThan(startedAt);
    const ttsOutputStartedAt = new Date(ttsStartEvent.at).toISOString();

    // Report the real audio characteristics for the PR evidence log.
    if (ttsAudio) {
      const wav = inspectWav(ttsAudio);
      console.log(
        `[voice-live] STT="${asrTranscript}" TTS bytes=${ttsBytes} ` +
          `type=${ttsContentType} wav=${wav.isWav} durationMs=${wav.durationMs} peak=${wav.peak}`,
      );
      if (wav.isWav) {
        expect(wav.peak, "cloud TTS audio must be non-silent").toBeGreaterThan(
          32,
        );
      }
    }

    const trajectoryListResponse = await page.request.get(
      "/api/trajectories?limit=50",
    );
    expect(
      trajectoryListResponse.ok(),
      "the live lane must export the correlated agent trajectory",
    ).toBe(true);
    const trajectoryList = (await trajectoryListResponse.json()) as {
      trajectories?: Array<{
        id?: unknown;
        startTime?: unknown;
        roomId?: unknown;
        llmCallCount?: unknown;
        metadata?: unknown;
      }>;
    };
    const trajectory = selectVoiceTrajectory(
      trajectoryList.trajectories ?? [],
      {
        startedAt,
        roomId: String(conversation?.roomId),
        userMessageId: String(streamDone?.userMessageId),
      },
    );
    expect(
      trajectory?.id,
      "a new live-model trajectory with at least one LLM call is required",
    ).toEqual(expect.any(String));
    const trajectoryResponse = await page.request.get(
      `/api/trajectories/${encodeURIComponent(String(trajectory?.id))}`,
    );
    expect(trajectoryResponse.ok()).toBe(true);
    const trajectoryDetail = await trajectoryResponse.json();
    await testInfo.attach("voice-live-trajectory.json", {
      body: Buffer.from(`${JSON.stringify(trajectoryDetail, null, 2)}\n`),
      contentType: "application/json",
    });
    await testInfo.attach("voice-live-network.json", {
      body: Buffer.from(
        `${JSON.stringify(
          {
            startedAt: new Date(startedAt).toISOString(),
            audioOutput: {
              reference: referenceOutput,
              ttsStartedAt: ttsOutputStartedAt,
            },
            asr: {
              path: new URL(asrResponse.url()).pathname,
              status: asrResponse.status(),
              transcript: asrTranscript,
            },
            agent: {
              path: new URL(streamResponse.url()).pathname,
              status: streamResponse.status(),
              conversationId,
              roomId: conversation?.roomId,
              messageId: streamDone?.messageId,
              userMessageId: streamDone?.userMessageId,
              trajectoryId: trajectory?.id,
            },
            tts: {
              path: new URL(ttsResponse.url()).pathname,
              status: ttsResponse.status(),
              contentType: ttsContentType,
              bytes: ttsBytes,
            },
          },
          null,
          2,
        )}\n`,
      ),
      contentType: "application/json",
    });
  });
});
