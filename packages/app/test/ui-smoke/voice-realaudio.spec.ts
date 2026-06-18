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
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-realaudio.spec.ts
 */
import { expect, type Page, test } from "@playwright/test";
import { installDefaultAppRoutes, seedAppStorage } from "./helpers";

const EXPECTED_PHRASE = "what time is it";

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

async function installVoiceBackendMocks(page: Page): Promise<void> {
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
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversation: { id: "voice-selftest-convo", roomId: "voice-selftest" },
      }),
    });
  });
  await page.route(
    "**/api/conversations/voice-selftest-convo/messages/stream",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `data: ${JSON.stringify({ type: "token", text: "It is", fullText: "It is" })}\n\n` +
          `data: ${JSON.stringify({ type: "done", fullText: "It is noon.", agentName: "Eliza" })}\n\n`,
      });
    },
  );
  const wav = tinyWav();
  for (const r of ["**/api/tts/cloud", "**/api/tts/local-inference"]) {
    await page.route(r, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({
        status: 200,
        headers: { "content-type": "audio/wav" },
        body: wav,
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
  expect(Number(asr?.detail?.wer ?? 1)).toBeLessThanOrEqual(0.34);
});
