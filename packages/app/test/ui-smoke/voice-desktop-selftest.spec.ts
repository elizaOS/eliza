/**
 * Exercises the desktop voice self-test renderer with a synthetic native bridge
 * and controlled ASR, conversation, and TTS responses. The browser drives the
 * real self-test UI and verifies desktop TTS routing; native shell and physical
 * audio-device behavior belong to the packaged Electrobun lane.
 */

import { expect, type Page, test } from "@playwright/test";
import { installDefaultAppRoutes, seedAppStorage } from "./helpers";
import { installDesktopBridgeFixture } from "./helpers/desktop-bridge";
import { tinyWav } from "./helpers/wav-fixture";

const EXPECTED_PHRASE = "what time is it";

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
  await installDesktopBridgeFixture(page);
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
