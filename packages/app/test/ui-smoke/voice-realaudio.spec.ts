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
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

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
          probe.events.push({ type: "start", id, at: performance.now() });
          return originalStart(...args);
        }) as AudioBufferSourceNode["start"];
        source.stop = ((...args: unknown[]) => {
          probe.stops += 1;
          probe.events.push({ type: "stop", id, at: performance.now() });
          return originalStop(...args);
        }) as AudioBufferSourceNode["stop"];
        source.disconnect = ((...args: unknown[]) => {
          probe.disconnects += 1;
          probe.events.push({
            type: "disconnect",
            id,
            at: performance.now(),
          });
          return originalDisconnect(...args);
        }) as AudioBufferSourceNode["disconnect"];
        source.addEventListener("ended", () => {
          probe.ended += 1;
          probe.events.push({ type: "ended", id, at: performance.now() });
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
  await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
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
  await expect(mic).toHaveAttribute(
    "aria-label",
    "stop transcription and mic",
    {
      timeout: 15_000,
    },
  );
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
    await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
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
    await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
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
    await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
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
  }) => {
    await installCloudVoiceConfig(page);
    await installAudioSourceProbe(page);

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

    let asrTranscript = "";
    let ttsBytes = 0;
    let ttsContentType = "";
    let ttsAudio: Buffer | null = null;
    page.on("response", async (res) => {
      const url = res.url();
      if (url.includes("/api/asr/cloud") && res.ok()) {
        // error-policy:J6 diagnostic capture — a failed body read must not mask
        // the assertion below, which fails loudly on an empty transcript.
        const json = (await res.json().catch(() => null)) as {
          text?: unknown;
        } | null;
        if (typeof json?.text === "string") asrTranscript = json.text;
      }
      if (url.includes("/api/tts/cloud") && res.ok()) {
        ttsContentType = res.headers()["content-type"] ?? "";
        const body = await res.body().catch(() => Buffer.alloc(0));
        ttsBytes = body.byteLength;
        ttsAudio = body;
      }
    });

    await openAppPath(page, "/chat");
    await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
      timeout: 30_000,
    });
    const mic = page.getByTestId("chat-composer-mic");
    await expect(mic).toHaveAttribute("aria-label", "talk", {
      timeout: 15_000,
    });

    await mic.click();
    await expect(mic).toHaveAttribute("aria-label", "end conversation", {
      timeout: 15_000,
    });
    await page.waitForTimeout(2500);
    await mic.click();

    // Real cloud STT returned the injected phrase (the fixture speaks it).
    await expect
      .poll(() => asrTranscript.toLowerCase(), {
        timeout: 60_000,
        message: "cloud STT must transcribe the injected known phrase",
      })
      .toContain("time");

    // Real cloud TTS returned decoded, non-silent audio that actually played.
    await expect
      .poll(() => ttsBytes, {
        timeout: 60_000,
        message: "cloud TTS must return a non-trivial audio body",
      })
      .toBeGreaterThan(2000);
    expect(ttsContentType).toContain("audio");
    await expect
      .poll(async () => (await readAudioProbe(page)).starts, {
        timeout: 30_000,
        message: "the decoded cloud TTS audio must start real playback",
      })
      .toBeGreaterThan(0);

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
  });
});
