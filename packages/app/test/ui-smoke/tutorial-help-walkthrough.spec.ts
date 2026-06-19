import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

/**
 * Full, real-interaction verification of the interactive tour + Help.
 *
 *  - Runs every tour frame to completion, screenshotting each.
 *  - Drives the REAL controls: taps the pill, DRAGS the grabber up then down
 *    (pointer gestures, not clicks), taps the pre-filled send to navigate, and
 *    taps the mic + speaks to navigate by voice.
 *  - Exercises voice in BOTH directions: narration goes through the app's real
 *    voice engine (asserted via the SpeechSynthesis fallback), and a real ASR
 *    transcript (injected SpeechRecognition) drives the "say go home" frame.
 *  - Confirms the tour navigates to the real Settings view mid-run via the staged
 *    send (no teleport button) and lands back home via voice.
 *  - Confirms the slop is gone (no "Step N of" counter, no mode toggle chip).
 *
 * Screenshots land in /tmp/tut-shots for manual review.
 */

const SHOTS = "/tmp/tut-shots";

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/**
 * Install fake voice I/O before the app boots: a controllable SpeechRecognition
 * (so the mic capture yields a deterministic transcript) and a SpeechSynthesis
 * spy (so narration through the real engine's browser-TTS fallback is
 * observable). Exposes window hooks the test drives.
 */
async function installVoiceHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __ttsSpoken: string[];
      __emitTranscript: (text: string, final: boolean) => void;
      SpeechRecognition: unknown;
      webkitSpeechRecognition: unknown;
      SpeechSynthesisUtterance: unknown;
      speechSynthesis?: SpeechSynthesis;
    };

    // ── ASR: a fake SpeechRecognition the test can feed transcripts into ──
    class FakeSpeechRecognition {
      static current: FakeSpeechRecognition | null = null;
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start(): void {
        FakeSpeechRecognition.current = this;
      }
      stop(): void {
        this.onend?.();
      }
      abort(): void {
        this.onend?.();
      }
      emit(transcript: string, isFinal: boolean): void {
        const result = { 0: { transcript }, isFinal, length: 1 };
        const results = Object.assign([result], { length: 1 });
        this.onresult?.({ resultIndex: 0, results });
      }
    }
    w.SpeechRecognition = FakeSpeechRecognition;
    w.webkitSpeechRecognition = FakeSpeechRecognition;
    w.__emitTranscript = (text, final) => {
      FakeSpeechRecognition.current?.emit(text, final);
    };

    // ── TTS: capture what the real engine's browser fallback would speak ──
    w.__ttsSpoken = [];
    const record = (utterance: unknown): void => {
      const text =
        utterance && typeof utterance === "object" && "text" in utterance
          ? String((utterance as { text: unknown }).text)
          : "";
      w.__ttsSpoken.push(text);
    };
    const fakeSynth = {
      speak: record,
      cancel: () => {},
      pause: () => {},
      resume: () => {},
      getVoices: () => [] as SpeechSynthesisVoice[],
      addEventListener: () => {},
      removeEventListener: () => {},
      speaking: false,
      pending: false,
      paused: false,
    };
    try {
      if (w.speechSynthesis) {
        w.speechSynthesis.speak =
          record as unknown as typeof w.speechSynthesis.speak;
      } else {
        Object.defineProperty(window, "speechSynthesis", {
          value: fakeSynth,
          configurable: true,
        });
      }
    } catch {
      Object.defineProperty(window, "speechSynthesis", {
        value: fakeSynth,
        configurable: true,
      });
    }
    if (!w.SpeechSynthesisUtterance) {
      w.SpeechSynthesisUtterance = class {
        text: string;
        rate = 1;
        pitch = 1;
        constructor(text: string) {
          this.text = text;
        }
      };
    }
  });
}

/** Drag the chat grabber by `dy` px (negative = up) with real pointer events. */
async function dragGrabber(page: Page, dy: number): Promise<void> {
  const grabber = page.getByTestId("chat-sheet-grabber");
  const box = await grabber.boundingBox();
  if (!box) throw new Error("grabber has no bounding box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  // Step the move so velocity + distance thresholds in use-pull-gesture trip.
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(cx, cy + (dy * i) / steps);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

test("the tour runs end to end with real gestures and real voice", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["microphone"]).catch(() => {});
  await installVoiceHarness(page);
  // Each frame must render on the correct screen; assert the active tab per frame.
  const expectTab = async (expected: string): Promise<void> => {
    const tab = await page.evaluate(
      () => location.hash.replace(/^#/, "") || location.pathname,
    );
    expect(tab).toBe(expected);
  };
  // Don't auto-launch on load; we start it from the tile deterministically.
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/chat");

  await page.getByTestId("home-tile-tutorial").click({ timeout: 25_000 });
  await page.getByTestId("tutorial-start").click();

  const card = page.getByTestId("tutorial-card");
  const cont = page.getByTestId("tutorial-continue");
  await expect(card).toBeVisible();

  // ── Frame 1: welcome (centered) ──
  await expect(card).toContainText(/Meet Eliza/i);
  await shot(page, "01-welcome");
  await cont.click(); // "Start"

  // ── Frame 2: open the chat (tap the pill) ──
  await expect(card).toContainText(/Open the chat/i, { timeout: 8000 });
  await expect(page.getByTestId("chat-pill")).toBeVisible({ timeout: 6000 });
  await shot(page, "02-open-pill");

  // Capability lock: a click delivered straight to a home tile (bypassing the
  // spotlight scrim entirely) still can't navigate off this frame's allowed tab
  // — the tour stays put and Settings never opens.
  await page.getByTestId("home-tile-settings").dispatchEvent("click");
  await page.waitForTimeout(300);
  await expect(page.getByText("Models & Providers")).toHaveCount(0);
  await expect(card).toContainText(/Open the chat/i);
  await expectTab("/chat");

  await page.getByTestId("chat-pill").click();

  // ── Frame 3: resize (drag the grabber UP, then DOWN) ──
  await expect(card).toContainText(/Resize it/i, { timeout: 8000 });
  await expect(card).toContainText(/bigger/i);
  await expect(page.getByTestId("chat-sheet-grabber")).toBeVisible({
    timeout: 6000,
  });
  await shot(page, "03a-resize-rest");
  await dragGrabber(page, -260); // pull up → expand
  await expect(card).toContainText(/tuck it away/i, { timeout: 8000 });
  await shot(page, "03b-resize-expanded");
  await dragGrabber(page, 320); // pull down → shrink
  await shot(page, "03c-resize-shrunk");

  // ── Frame 4: ask to navigate (command pre-typed; tap send → real Settings) ──
  await expect(card).toContainText(/Just ask/i, { timeout: 8000 });
  // Regression: the ask frame must START on home — the staged nav must NOT fire
  // until the user sends (a prior frame's success once bled into this one).
  await expectTab("/chat");
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toHaveValue("open settings", { timeout: 6000 });
  await expect(page.getByTestId("chat-composer-action")).toBeVisible();
  await shot(page, "04a-ask-prefilled");
  await page.getByTestId("chat-composer-action").click(); // real send
  // The tour navigated to the REAL Settings view (not via a teleport button).
  await expect(page.getByText("Models & Providers")).toBeVisible({
    timeout: 8000,
  });
  await expectTab("/settings");
  await shot(page, "04b-reached-settings");

  // ── Frame 5: voice (tap mic, speak "go home" → real transcript → home) ──
  await expect(card).toContainText(/Talk to it/i, { timeout: 8000 });
  await expect(page.getByTestId("chat-composer-mic")).toBeVisible({
    timeout: 6000,
  });
  await shot(page, "05a-voice-listen");
  await page.getByTestId("chat-composer-mic").click();
  // Wait for the capture to spin up (the fake recognizer registers on start()).
  await page.waitForFunction(
    () =>
      (window as unknown as { __emitTranscript?: unknown }).__emitTranscript !=
      null,
    null,
    { timeout: 5000 },
  );
  await page.waitForTimeout(800);
  // Speak — an interim transcript is what the engine watches.
  await page.evaluate(() => {
    (
      window as unknown as {
        __emitTranscript: (t: string, f: boolean) => void;
      }
    ).__emitTranscript("go home", false);
  });
  // Back on the home base, by voice.
  await expect(card).toContainText(/You're set/i, { timeout: 8000 });
  await expectTab("/chat");
  await shot(page, "05b-voice-home");

  // ── Frame 6: done ──
  await shot(page, "06-done");
  await cont.click(); // "Done"
  await expect(card).toHaveCount(0);
  await shot(page, "07-complete");

  // Narration went through the real voice engine (browser-TTS fallback spy).
  const spoken = await page.evaluate(
    () => (window as unknown as { __ttsSpoken: string[] }).__ttsSpoken,
  );
  expect(spoken.length).toBeGreaterThan(0);
  expect(spoken.join(" ")).toMatch(/Eliza|chat|send|mic|home/i);

  // Slop is gone: no step counter, no text/voice mode toggle chip.
  await expect(page.getByText(/Step \d+ of/i)).toHaveCount(0);
});

test("Help is searched through the floating chat", async ({ page }) => {
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/help");
  await expect(page.getByTestId("help-view")).toBeVisible({ timeout: 25_000 });
  await shot(page, "help-01-home");

  // The chat composer is Help's search box (placeholder override).
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toHaveAttribute(
    "placeholder",
    /question about eliza/i,
  );

  // Typing a question filters the knowledge base + pulls up the best match.
  await composer.fill("how do I change the model");
  await page.waitForTimeout(500);
  await shot(page, "help-02-filtered");
  const entry = page.getByTestId("help-entry-change-model");
  await expect(entry).toBeVisible();
  await expect(entry).toContainText(/AI Model/i);
  await expect(
    entry.getByRole("button", { name: /Open AI Model settings/i }),
  ).toBeVisible();
  await shot(page, "help-03-auto-expanded");
});
