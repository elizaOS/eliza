/**
 * Drives the self-driving voice self-test screen (?shellMode=voice-selftest)
 * end-to-end with NO human and NO microphone.
 *
 * The screen's `runVoiceSelfTest` harness calls the REAL production functions
 * (transcribeLocalInferenceWav, ElizaClient.sendConversationMessageStream, a
 * real TTS fetch + AudioContext.decodeAudioData). Here the BACKENDS are mocked
 * (the ASR/agent/TTS models are not provisioned in CI), so this proves the full
 * CLIENT round-trip + the screen + the machine-readable verdict — the same
 * surface the android/desktop lanes drive against a real on-device agent.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-selftest-e2e.spec.ts
 */

import { expect, type Page, test } from "@playwright/test";
import { installDefaultAppRoutes, seedAppStorage } from "./helpers";
import { tinyWav } from "./helpers/wav-fixture";

const EXPECTED_PHRASE = "what time is it";

async function installVoiceBackendMocks(page: Page): Promise<void> {
  // ASR readiness + transcription.
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
  // Conversation create + streamed reply.
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
          `data: ${JSON.stringify({ type: "done", fullText: "It is half past noon.", agentName: "Eliza" })}\n\n`,
      });
    },
  );
  // TTS — return a real decodable WAV so the decode stage actually passes.
  const wav = tinyWav();
  for (const route of ["**/api/tts/cloud", "**/api/tts/local-inference"]) {
    await page.route(route, async (r) => {
      if (r.request().method() !== "POST") return r.fallback();
      await r.fulfill({
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

test("voice self-test screen reports overall=pass for the full STT->agent->TTS round-trip", async ({
  page,
}) => {
  await page.goto("/?shellMode=voice-selftest", {
    waitUntil: "domcontentloaded",
  });

  // The screen mounts and exposes the harness for automation.
  await expect(page.getByTestId("voice-selftest-shell")).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __voiceSelfTest?: unknown })
        .__voiceSelfTest === "function",
    { timeout: 30_000 },
  );

  // Drive the real harness deterministically and read the machine verdict.
  const report = await page.evaluate(
    async () =>
      await (
        window as unknown as {
          __voiceSelfTest: (o?: { mode?: string }) => Promise<{
            overall: string;
            stages: Array<{ stage: string; status: string; error?: string }>;
            transcript: string;
            reply: string;
          }>;
        }
      ).__voiceSelfTest({ mode: "wav-direct" }),
  );

  expect(report.overall, `stages: ${JSON.stringify(report.stages)}`).toBe(
    "pass",
  );
  const byStage = Object.fromEntries(
    report.stages.map((s) => [s.stage, s.status]),
  );
  expect(byStage.asr).toBe("pass");
  expect(byStage.send).toBe("pass");
  expect(byStage.tts).toBe("pass");
  // This Chromium lane's ASR is a mock that echoes a fixed phrase, so the
  // `contains("time")` below proves the transcript PROPAGATED through the
  // capture→ASR→report pipeline — it is NOT an accuracy measure (that lives in
  // the real-recognizer tiers, #10726). The stage-pass asserts above are the
  // wiring proof; the WER accuracy assertion was removed from the mock lanes.
  expect(report.transcript.toLowerCase()).toContain("time");
  expect(report.reply.length).toBeGreaterThan(0);

  // The DOM mirror also reflects pass, so a non-JS scraper can read the verdict.
  await expect(page.getByTestId("voice-selftest-overall")).toHaveAttribute(
    "data-overall",
    "pass",
  );
});
