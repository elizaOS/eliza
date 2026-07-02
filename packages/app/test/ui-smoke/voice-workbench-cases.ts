/**
 * Shared fixtures + a parameterized driver for the Voice Workbench scenario-player
 * e2e specs (#8785).
 *
 * Each `voice-workbench-*.spec.ts` declares a small WorkbenchScenario for one
 * browser wiring case and calls {@link runWorkbenchScenarioSpec}. The driver
 * mocks the ASR / agent / TTS backends (none are provisioned in CI), navigates
 * to the `?shellMode=voice-workbench` screen, drives the REAL client player via
 * `window.__voiceWorkbench(scenario)`, and asserts the per-turn DOM verdicts.
 *
 * The backends are mocked but every CLIENT step is real: corpus WAV load,
 * transcript propagation, streamed response/no-response handling, TTS decode,
 * and DOM mirroring. Model-quality scoring (ASR accuracy, diarization,
 * voice/entity recognition) belongs to the tier-2/tier-3 lanes with real signals.
 */
import { expect, type Page, test } from "@playwright/test";
import { installDefaultAppRoutes, seedAppStorage } from "./helpers";

/** Structural mirror of the player's WorkbenchTurn (kept local to the spec). */
export interface SpecTurn {
  speaker: string;
  text: string;
  /** Ground-truth respond decision; drives the agent mock + the assertion. */
  expectRespond: boolean;
  /** Override the ASR transcript the mock returns for this turn (else `text`). */
  asrText?: string;
  expectedTranscript?: string;
  expectedSpeakerLabel?: string;
  expectedEntity?: string;
  pausesMs?: number[];
}

export interface SpecScenario {
  id: string;
  description?: string;
  classes: string[];
  participants: Array<{
    label: string;
    ttsVoiceId?: string;
    entityId?: string;
    isOwner?: boolean;
  }>;
  agents?: string[];
  turns: SpecTurn[];
}

/** A valid, decodable 16 kHz mono PCM WAV so AudioContext.decodeAudioData works. */
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

const CONVO_ID = "voice-workbench-convo";

/**
 * Mock every backend the player touches, scoped to one scenario:
 *   - per-turn corpus WAV (GET /voice-corpus/<id>/turn-<i>.wav)
 *   - ASR readiness + transcription (returns each turn's transcript)
 *   - conversation create + a streamed reply per turn (respond / no-respond)
 *   - TTS (a real decodable WAV)
 *
 * The agent stream answers from a shared turn cursor: a respond turn streams a
 * non-empty reply; a no-respond turn streams `done` with `noResponseReason:
 * "ignored"` — exactly how the real client signals "the agent chose not to
 * respond" (resolved reply text becomes "").
 */
async function installScenarioMocks(
  page: Page,
  scenario: SpecScenario,
): Promise<void> {
  const wav = tinyWav();

  // Corpus clips — one valid WAV per turn so resolveTurnWav succeeds.
  await page.route(`**/voice-corpus/${scenario.id}/**`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      headers: { "content-type": "audio/wav" },
      body: wav,
    });
  });

  await page.route("**/api/asr/local-inference/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ready: true, provider: "local-inference" }),
    });
  });

  // ASR returns the per-turn transcript in scenario order. The player POSTs one
  // ASR request per turn; we walk the turns with a cursor so each turn gets its
  // own mocked transcript. This lane proves propagation, not recognizer accuracy.
  let asrCursor = 0;
  await page.route("**/api/asr/local-inference", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const turn = scenario.turns[asrCursor];
    asrCursor += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: turn?.asrText ?? turn?.text ?? "" }),
    });
  });

  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversation: { id: CONVO_ID, roomId: "voice-workbench" },
      }),
    });
  });

  // Agent stream — answer respond / no-respond per turn, in order.
  let sendCursor = 0;
  await page.route(
    `**/api/conversations/${CONVO_ID}/messages/stream`,
    async (route) => {
      const turn = scenario.turns[sendCursor];
      sendCursor += 1;
      const body = turn?.expectRespond
        ? `data: ${JSON.stringify({ type: "token", text: "ok", fullText: "ok" })}\n\n` +
          `data: ${JSON.stringify({ type: "done", fullText: `reply to ${turn.speaker}`, agentName: "Eliza" })}\n\n`
        : // No-respond: terminal `done` with noResponseReason "ignored" → the
          // real client resolves reply text to "" (the agent chose not to reply).
          `data: ${JSON.stringify({ type: "done", fullText: "", noResponseReason: "ignored", agentName: "Eliza" })}\n\n`;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body,
      });
    },
  );

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

interface WorkbenchReport {
  overall: string;
  scenarioId: string;
  classes: string[];
  turns: Array<{
    index: number;
    speaker: string;
    expectedSpeakerLabel: string;
    predictedSpeakerLabel: string | null;
    status: string;
    responded: boolean;
    expectRespond: boolean;
    transcript: string;
    expectedTranscript: string;
    reply: string;
    error?: string;
    detail?: Record<string, unknown>;
  }>;
  diarization: {
    status: string;
    total: number;
    der: number;
    confusions: number;
    unattributed: number;
    maxDer: number;
    evaluated: boolean;
    passed: boolean;
    reason?: string;
  };
}

/**
 * Drive one scenario end-to-end through the headful player and assert the
 * per-turn DOM verdicts. Mocked backends are always CI-runnable, so this must
 * PASS; skipped cases are failures in this keyless lane.
 */
export function runWorkbenchScenarioSpec(scenario: SpecScenario): void {
  test.beforeEach(async ({ page }) => {
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    await installScenarioMocks(page, scenario);
  });

  test(`voice workbench browser wiring [${scenario.classes.join(",")}] case ${scenario.id} round-trips mocked backend turns`, async ({
    page,
  }) => {
    await page.goto("/?shellMode=voice-workbench", {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByTestId("voice-workbench-shell")).toBeVisible({
      timeout: 30_000,
    });
    await page.waitForFunction(
      () =>
        typeof (window as unknown as { __voiceWorkbench?: unknown })
          .__voiceWorkbench === "function",
      { timeout: 30_000 },
    );

    const report = await page.evaluate(
      async (s) =>
        await (
          window as unknown as {
            __voiceWorkbench: (scenario: unknown) => Promise<WorkbenchReport>;
          }
        ).__voiceWorkbench(s),
      scenario,
    );

    // Mocked ASR / agent / TTS backends are present, so the browser wiring case
    // must resolve cleanly. The mock lane has no real speaker-attribution model;
    // it must keep the attribution/DER gate skipped rather than fabricating
    // labels from scenario metadata.
    expect(
      report.overall,
      `turns: ${JSON.stringify(report.turns, null, 2)}`,
    ).toBe("pass");
    expect(report.scenarioId).toBe(scenario.id);
    expect(report.classes).toEqual(scenario.classes);
    expect(report.turns).toHaveLength(scenario.turns.length);
    expect(report.diarization.status, "mock-lane diarization status").toBe(
      "skipped",
    );
    expect(
      report.diarization.passed,
      "mock lane must not fabricate a passing DER",
    ).toBe(false);
    expect(report.diarization.total, "diarization scored turns").toBe(0);
    expect(report.diarization.evaluated, "diarization evaluated").toBe(false);
    expect(report.diarization.unattributed, "unattributed turns").toBe(
      scenario.turns.length,
    );
    expect(report.diarization.reason ?? "").toContain(
      "speaker attribution is not available",
    );

    // Every turn's response-state decision must match the mocked SSE stream and
    // no turn failed. Speaker labels and entity hints are report metadata only in
    // this lane; predicted labels stay null because no attribution model runs.
    for (let i = 0; i < scenario.turns.length; i += 1) {
      const turn = report.turns[i];
      const expected = scenario.turns[i];
      const expectedSpeakerLabel =
        expected.expectedSpeakerLabel ?? expected.speaker;
      const expectedTranscript = expected.asrText ?? expected.text ?? "";
      expect(turn.status, `turn ${i} (${turn.error ?? "no error"})`).toBe(
        "pass",
      );
      expect(turn.responded, `turn ${i} respond decision`).toBe(
        expected.expectRespond,
      );
      expect(
        turn.expectedSpeakerLabel,
        `turn ${i} expected speaker label`,
      ).toBe(expectedSpeakerLabel);
      expect(turn.transcript, `turn ${i} transcript propagation`).toBe(
        expectedTranscript,
      );
      expect(
        turn.expectedTranscript,
        `turn ${i} expected transcript metadata`,
      ).toBe(expected.expectedTranscript ?? expected.text ?? "");
      expect(
        turn.predictedSpeakerLabel,
        `turn ${i} predicted speaker label is unavailable in the mock lane`,
      ).toBeNull();
      expect(
        turn.detail?.speakerAttributionRan,
        `turn ${i} speaker attribution ran`,
      ).toBe(false);
      if (expected.expectedEntity) {
        expect(turn.detail?.expectedEntity, `turn ${i} expected entity`).toBe(
          expected.expectedEntity,
        );
      }
    }

    // DOM mirror: per-turn elements carry the verdict for a non-JS scraper.
    for (let i = 0; i < scenario.turns.length; i += 1) {
      const turnEl = page.getByTestId(`voice-workbench-turn-${i}`);
      await expect(turnEl).toBeVisible();
      const status = await turnEl.getAttribute("data-status");
      expect(status, `turn ${i} DOM status`).toBe("pass");
      await expect(turnEl).toHaveAttribute(
        "data-expected-speaker-label",
        scenario.turns[i].expectedSpeakerLabel ?? scenario.turns[i].speaker,
      );
      await expect(turnEl).toHaveAttribute("data-predicted-speaker-label", "");
    }

    // Overall DOM verdict reflects the report.
    await expect(page.getByTestId("voice-workbench-overall")).toHaveAttribute(
      "data-overall",
      report.overall,
    );
    await expect(page.getByTestId("voice-workbench-overall")).toHaveAttribute(
      "data-der",
      String(report.diarization.der),
    );
    await expect(page.getByTestId("voice-workbench-overall")).toHaveAttribute(
      "data-diarization-status",
      "skipped",
    );
  });
}
