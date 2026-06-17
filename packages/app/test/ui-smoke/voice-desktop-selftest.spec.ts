/**
 * DESKTOP voice self-test (Electrobun renderer path), headless.
 *
 * The desktop voice surface is the SAME renderer bundle as web — the Electrobun
 * pill loads it with a ?shellMode= param over a Chromium-engine webview. We
 * inject the Electrobun runtime marker (window.__electrobunWindowId) so the
 * self-test screen detects platform=desktop and routes TTS through the desktop
 * local-inference TTS route, then drive the real round-trip harness. This proves
 * the desktop CONFIG path of the voice self-test green in CI without a packaged
 * Electrobun build. (The native Electrobun shell integration — talkmodeSpeak
 * main-process bridge, views:// mic grant — is exercised by the packaged
 * electrobun-packaged lane.)
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-desktop-selftest.spec.ts
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
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: EXPECTED_PHRASE }),
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
  // Desktop routes TTS through local-inference; cover cloud too defensively.
  for (const r of ["**/api/tts/local-inference", "**/api/tts/cloud"]) {
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
  // Make the renderer detect the Electrobun (desktop) runtime BEFORE boot.
  await page.addInitScript(() => {
    (
      window as unknown as { __electrobunWindowId?: number }
    ).__electrobunWindowId = 1;
  });
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await installVoiceBackendMocks(page);
});

test("desktop voice self-test reports overall=pass and uses the local-inference TTS route", async ({
  page,
}) => {
  await page.goto("/?shellMode=voice-selftest", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("voice-selftest-shell")).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __voiceSelfTest?: unknown })
        .__voiceSelfTest === "function",
    { timeout: 30_000 },
  );

  const report = await page.evaluate(
    async () =>
      await (
        window as unknown as {
          __voiceSelfTest: (o?: { mode?: string }) => Promise<{
            overall: string;
            platform: string;
            ttsRoute: string;
            stages: Array<{ stage: string; status: string }>;
          }>;
        }
      ).__voiceSelfTest({ mode: "wav-direct" }),
  );

  expect(report.overall, `stages: ${JSON.stringify(report.stages)}`).toBe(
    "pass",
  );
  // Desktop config: platform detected as desktop, TTS via local-inference.
  expect(report.platform).toBe("desktop");
  expect(report.ttsRoute).toBe("/api/tts/local-inference");
  const byStage = Object.fromEntries(
    report.stages.map((s) => [s.stage, s.status]),
  );
  expect(byStage.asr).toBe("pass");
  expect(byStage.send).toBe("pass");
  expect(byStage.tts).toBe("pass");
});
