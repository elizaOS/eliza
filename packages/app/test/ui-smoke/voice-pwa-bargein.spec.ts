/**
 * REAL-AUDIO barge-in invariants for the future full-duplex path
 * (sol-voice-pwa-e2e). Runs in `chromium-voice-mic`.
 *
 * Extends the proven barge-in in voice-realaudio.spec.ts with the STRONGER
 * invariants the Deepgram-Flux -> Gemma -> Cartesia streaming path must hold:
 *
 *   B1  starting transcription while a long TTS clip plays silences it, and the
 *       silence lands within a (generous CI) budget; actual ms is recorded to
 *       the latency artifact for the runbook.
 *   B2  NO stale audio after cancel — once barged-in, the interrupted source
 *       emits no new `start`, and its start/stop/disconnect reconcile.
 *   B3  double-tap idempotency — firing START_TRANSCRIPTION twice rapidly opens
 *       exactly one capture session (no duplicate ASR POST storm).
 *
 * REAL: fake-device audio capture, WAV POSTs, Web Audio playback + barge-in.
 * MOCKED: ASR/SSE/TTS backends. Mirrors voice-realaudio's mock shapes.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-pwa-bargein.spec.ts
 */
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { writeVoiceLatencyArtifact } from "./helpers/voice-latency-artifact";

const EXPECTED_PHRASE = "what time is it";
const CONV = "voice-pwa-bargein-convo";
const ROOM = "voice-pwa-bargein-room";
const LONG_REPLY =
  "This is a deliberately long spoken reply so the user has time to interrupt " +
  "me with the microphone while I am still talking through the streaming voice " +
  "pipeline under test in this acceptance lane.";

interface Probe {
  starts: number;
  stops: number;
  disconnects: number;
  ended: number;
  events: Array<{ type: string; id: number; at: number }>;
}

function tinyWav(seconds = 0.2, sampleRate = 16000): Buffer {
  const n = Math.floor(sampleRate * seconds);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1)
    pcm.writeInt16LE(
      Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / sampleRate)),
      i * 2,
    );
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

async function installAudioSourceProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Ev = { type: string; id: number; at: number };
    type P = {
      starts: number;
      stops: number;
      disconnects: number;
      ended: number;
      events: Ev[];
    };
    const w = window as unknown as {
      __voiceAudioProbe?: P;
      __voiceAudioProbeInstalled?: boolean;
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    if (w.__voiceAudioProbeInstalled) return;
    w.__voiceAudioProbeInstalled = true;
    const probe: P = {
      starts: 0,
      stops: 0,
      disconnects: 0,
      ended: 0,
      events: [],
    };
    w.__voiceAudioProbe = probe;
    let nextId = 0;
    const patch = (Ctor?: typeof AudioContext) => {
      const proto = Ctor?.prototype as
        | (AudioContext & { __probed?: boolean })
        | undefined;
      if (!proto || proto.__probed) return;
      proto.__probed = true;
      const orig = proto.createBufferSource;
      proto.createBufferSource = function () {
        const s = orig.call(this);
        nextId += 1;
        const id = nextId;
        const os = s.start.bind(s);
        const ost = s.stop.bind(s);
        const od = s.disconnect.bind(s);
        s.start = ((...a: unknown[]) => {
          probe.starts += 1;
          probe.events.push({ type: "start", id, at: performance.now() });
          return (os as (...x: unknown[]) => void)(...a);
        }) as AudioBufferSourceNode["start"];
        s.stop = ((...a: unknown[]) => {
          probe.stops += 1;
          probe.events.push({ type: "stop", id, at: performance.now() });
          return (ost as (...x: unknown[]) => void)(...a);
        }) as AudioBufferSourceNode["stop"];
        s.disconnect = ((...a: unknown[]) => {
          probe.disconnects += 1;
          probe.events.push({ type: "disconnect", id, at: performance.now() });
          return (od as (...x: unknown[]) => void)(...a);
        }) as AudioBufferSourceNode["disconnect"];
        s.addEventListener("ended", () => {
          probe.ended += 1;
          probe.events.push({ type: "ended", id, at: performance.now() });
        });
        return s;
      };
    };
    patch(w.AudioContext);
    patch(w.webkitAudioContext);
  });
}

async function readProbe(page: Page): Promise<Probe> {
  return page.evaluate(
    () =>
      (window as unknown as { __voiceAudioProbe?: Probe })
        .__voiceAudioProbe ?? {
        starts: 0,
        stops: 0,
        disconnects: 0,
        ended: 0,
        events: [],
      },
  );
}

async function dispatchVoiceControl(
  page: Page,
  command: "start" | "stop",
): Promise<void> {
  await page.evaluate((c) => {
    window.dispatchEvent(
      new CustomEvent("eliza:voice-control", { detail: { command: c } }),
    );
  }, command);
}

async function installLocalVoiceConfig(page: Page): Promise<void> {
  await page.unroute("**/api/config").catch(() => {});
  await page.route("**/api/config", async (route) => {
    if (!["GET", "PATCH", "PUT"].includes(route.request().method()))
      return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        meta: { firstRunComplete: true },
        agents: {
          list: [{ id: "ui-smoke-agent", name: "Smoke", status: "running" }],
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
      }),
    });
  });
}

async function installBackendMocks(page: Page): Promise<void> {
  const messages: Array<Record<string, unknown>> = [];
  let created = false;
  await page.route("**/api/asr/local-inference/status", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ready: true, provider: "local-inference" }),
    }),
  );
  await page.route("**/api/asr/local-inference", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const bytes = route.request().postDataBuffer()?.byteLength ?? 0;
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
    const ts = new Date().toISOString();
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversations: created
            ? [
                {
                  id: CONV,
                  roomId: ROOM,
                  title: "Barge",
                  createdAt: ts,
                  updatedAt: ts,
                },
              ]
            : [],
        }),
      });
    }
    if (route.request().method() !== "POST") return route.fallback();
    created = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversation: {
          id: CONV,
          roomId: ROOM,
          title: "Barge",
          createdAt: ts,
          updatedAt: ts,
        },
      }),
    });
  });
  await page.route(`**/api/conversations/${CONV}/messages`, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ messages }),
        })
      : route.fallback(),
  );
  await page.route(
    `**/api/conversations/${CONV}/messages/stream`,
    async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        text?: string;
      };
      const now = Date.now();
      messages.push({
        id: `u-${messages.length + 1}`,
        role: "user",
        text: body.text?.trim() || EXPECTED_PHRASE,
        timestamp: now,
      });
      messages.push({
        id: `a-${messages.length + 1}`,
        role: "assistant",
        text: LONG_REPLY,
        timestamp: now + 1,
      });
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `data: ${JSON.stringify({ type: "token", text: LONG_REPLY, fullText: LONG_REPLY })}\n\n` +
          `data: ${JSON.stringify({ type: "done", fullText: LONG_REPLY, agentName: "Eliza" })}\n\n`,
      });
    },
  );
  await page.route(`**/api/conversations/${CONV}/greeting**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: "Ready.", localInference: null }),
    }),
  );
  await page.route(`**/api/conversations/${CONV}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            conversation: { id: CONV, roomId: ROOM, title: "Barge" },
          }),
        })
      : route.fallback(),
  );
  await page.route(`**/api/turns/${ROOM}/abort`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ aborted: true, roomId: ROOM }),
    }),
  );
  const longWav = tinyWav(8);
  const shortWav = tinyWav();
  for (const r of ["**/api/tts/cloud", "**/api/tts/local-inference"]) {
    await page.route(r, (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 200,
            headers: { "content-type": "audio/wav" },
            body: route.request().url().includes("local-inference")
              ? longWav
              : shortWav,
          })
        : route.fallback(),
    );
  }
}

test.beforeEach(async ({ page }) => {
  await installAudioSourceProbe(page);
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await installLocalVoiceConfig(page);
  await installBackendMocks(page);
});

async function driveFirstVoiceTurnAndStartPlayback(
  page: Page,
  asrPosts: number[],
): Promise<void> {
  const mic = page.getByTestId("chat-composer-mic");
  await expect(mic).toHaveAttribute("aria-label", "talk", { timeout: 15_000 });
  await mic.click();
  await expect(mic).toHaveAttribute("aria-label", "end conversation", {
    timeout: 15_000,
  });
  await page.waitForTimeout(1500);
  await mic.click();
  await expect
    .poll(() => asrPosts.length, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(async () => (await readProbe(page)).starts, { timeout: 25_000 })
    .toBeGreaterThan(0);
}

test("B1/B2 barge-in silences playback within budget and leaves no stale audio", async ({
  page,
}, testInfo) => {
  const asrPosts: number[] = [];
  page.on("request", (req) => {
    if (
      req.method() === "POST" &&
      req.url().includes("/api/asr/local-inference") &&
      !req.url().includes("/status")
    )
      asrPosts.push(req.postDataBuffer()?.byteLength ?? 0);
  });

  await openAppPath(page, "/chat");
  await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
    timeout: 30_000,
  });
  await driveFirstVoiceTurnAndStartPlayback(page, asrPosts);

  const before = await readProbe(page);
  const bargeAt = await page.evaluate(() => performance.now());
  await dispatchVoiceControl(page, "start");
  await expect(page.getByTestId("chat-composer-mic")).toHaveAttribute(
    "aria-label",
    "stop transcription",
    { timeout: 15_000 },
  );
  await expect
    .poll(
      async () => {
        const p = await readProbe(page);
        return p.disconnects + p.stops;
      },
      {
        timeout: 10_000,
        message: "barge-in must stop/disconnect the active source",
      },
    )
    .toBeGreaterThan(before.disconnects + before.stops);

  const afterBarge = await readProbe(page);
  // B1: record the silence latency to the artifact (soft CI ceiling only).
  const silenceEvent = afterBarge.events.find(
    (e) => (e.type === "stop" || e.type === "disconnect") && e.at >= bargeAt,
  );
  const silenceMs = silenceEvent ? silenceEvent.at - bargeAt : -1;
  expect(silenceMs, "barge-in silence must be observed").toBeGreaterThanOrEqual(
    0,
  );
  // Generous CI ceiling (NOT the prod 250ms P95 gate — that is a device gate).
  expect(silenceMs).toBeLessThan(5000);

  // B2: no stale audio — after the barge point, no NEW `start` for a source
  // that was already playing before the barge (the interrupted clip).
  const startsAfterBarge = afterBarge.events.filter(
    (e) => e.type === "start" && e.at > bargeAt,
  );
  // A fresh capture may create sources, but the INTERRUPTED source must not
  // restart: every pre-barge started id must be stopped or disconnected.
  const preBargeStartIds = new Set(
    afterBarge.events
      .filter((e) => e.type === "start" && e.at <= bargeAt)
      .map((e) => e.id),
  );
  const stoppedIds = new Set(
    afterBarge.events
      .filter(
        (e) =>
          (e.type === "stop" || e.type === "disconnect") && e.at >= bargeAt,
      )
      .map((e) => e.id),
  );
  for (const id of preBargeStartIds) {
    expect(
      stoppedIds.has(id),
      `interrupted source ${id} must be stopped after barge-in (no stale audio)`,
    ).toBe(true);
    // and it must not have restarted
    expect(
      startsAfterBarge.some((e) => e.id === id),
      `interrupted source ${id} must not restart after cancel`,
    ).toBe(false);
  }

  await writeVoiceLatencyArtifact(page, testInfo, {
    audioProbe: {
      starts: afterBarge.starts,
      stops: afterBarge.stops,
      disconnects: afterBarge.disconnects,
      ended: afterBarge.ended,
    },
    derived: { bargeInSilenceMs: silenceMs },
  });

  await page.waitForTimeout(1000);
  await dispatchVoiceControl(page, "stop");
  await expect
    .poll(() => asrPosts.length, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(2);
  expect(Math.min(...asrPosts)).toBeGreaterThan(1000);
});

test("B3 double-tap START_TRANSCRIPTION opens exactly one capture session", async ({
  page,
}) => {
  const asrPosts: number[] = [];
  page.on("request", (req) => {
    if (
      req.method() === "POST" &&
      req.url().includes("/api/asr/local-inference") &&
      !req.url().includes("/status")
    )
      asrPosts.push(req.postDataBuffer()?.byteLength ?? 0);
  });

  await openAppPath(page, "/chat");
  await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
    timeout: 30_000,
  });
  const mic = page.getByTestId("chat-composer-mic");
  await expect(mic).toHaveAttribute("aria-label", "talk", { timeout: 15_000 });

  // Fire START twice back-to-back — must be idempotent (one session).
  await dispatchVoiceControl(page, "start");
  await dispatchVoiceControl(page, "start");
  await expect(mic).toHaveAttribute("aria-label", "stop transcription", {
    timeout: 15_000,
  });
  await page.waitForTimeout(1500);
  await dispatchVoiceControl(page, "stop");

  // First, wait until the single intended capture session has POSTed its WAV.
  await expect
    .poll(() => asrPosts.length, {
      timeout: 25_000,
      message: "the one intended capture session must POST its WAV",
    })
    .toBeGreaterThanOrEqual(1);
  // Then hold a stability window: a duplicate session from the second `start`
  // would land shortly after the first. Asserting `.toBe(1)` on the poll above
  // would have gone green the instant the FIRST post arrived, masking a
  // late-arriving duplicate. Wait, then assert the count never exceeded one.
  await page.waitForTimeout(3000);
  expect(
    asrPosts.length,
    `double-tap must open exactly one capture session (saw ${asrPosts.length} ASR POSTs)`,
  ).toBe(1);
});
