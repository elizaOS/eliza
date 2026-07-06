/**
 * Playwright UI-smoke spec for the chat-native tutorial against the real
 * renderer fixture. The tour has no overlay engine: the conductor seeds one
 * assistant turn per step into the live transcript, choices ride the
 * `__tutorial__:` action channel, and typed "start/stop/restart tutorial"
 * commands drive it from the composer. Narration goes through the app's real
 * voice engine (asserted via the SpeechSynthesis fallback spy, `__ttsSpoken`).
 */
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const COMPOSER = '[data-testid="chat-composer-textarea"]';

/** Choice-button locator for a tour step's action value. */
function choice(page: Page, verb: string, stepId: string) {
  return page.getByTestId(`choice-__tutorial__:${verb}:${stepId}`);
}

/**
 * Install a SpeechSynthesis spy before the app boots so narration through the
 * voice engine's browser-TTS fallback is observable via `window.__ttsSpoken`.
 */
async function installTtsSpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __ttsSpoken: string[];
      SpeechSynthesisUtterance: unknown;
    };
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
      if (window.speechSynthesis) {
        window.speechSynthesis.speak =
          record as unknown as typeof window.speechSynthesis.speak;
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

async function typeAndSend(page: Page, text: string): Promise<void> {
  const composer = page.locator(COMPOSER).first();
  await composer.click();
  await composer.fill(text);
  await page.getByTestId("chat-composer-action").click();
}

/** Drag the sheet to FULL so the transcript (the tour surface) is visible. */
async function expandToFull(page: Page): Promise<void> {
  await page.locator(COMPOSER).first().click();
  const grabber = page.getByTestId("chat-sheet-grabber");
  if (await grabber.count()) {
    const box = await grabber.first().boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y - 320, { steps: 10 });
      await page.mouse.up();
    }
  }
}

async function tutorialStatus(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("eliza:tutorial-state");
    if (!raw) return null;
    return (JSON.parse(raw) as { status?: string }).status ?? null;
  });
}

test.beforeEach(async ({ page }) => {
  await installTtsSpy(page);
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("the chat-native tour runs end to end in the live transcript", async ({
  page,
}, testInfo) => {
  const shot = async (name: string) => {
    await testInfo.attach(name, {
      body: await page.screenshot({ fullPage: false }),
      contentType: "image/png",
    });
  };
  await openAppPath(page, "/chat");
  await expect(page.locator(COMPOSER).first()).toBeVisible({
    timeout: 25_000,
  });

  // Typed command starts the tour; the welcome turn lands in the transcript.
  await typeAndSend(page, "start tutorial");
  await expandToFull(page);
  await expect(choice(page, "next", "welcome")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/Want a quick tour\?/i)).toBeVisible();
  await shot("01-welcome-turn.png");

  // No overlay engine: no spotlight card, no dim, and the app stays fully
  // interactive (the composer is still editable mid-tour).
  await expect(page.getByTestId("tutorial-card")).toHaveCount(0);
  await expect(page.getByTestId("tutorial-spotlight")).toHaveCount(0);
  await expect(page.locator(COMPOSER).first()).toBeEnabled();

  // Next → the send-a-message step.
  await choice(page, "next", "welcome").click();
  await expect(choice(page, "next", "send-message")).toBeVisible({
    timeout: 10_000,
  });

  // Performing the step's real action auto-advances it: sending an ordinary
  // message lands the voice step WITHOUT tapping Next.
  await typeAndSend(page, "hello from the tour");
  await expect(choice(page, "next", "voice")).toBeVisible({ timeout: 10_000 });
  await shot("02-auto-advanced-after-send.png");

  // Manual Next remains the universal fallback for the remaining steps.
  await choice(page, "next", "voice").click();
  await expect(choice(page, "next", "navigate")).toBeVisible({
    timeout: 10_000,
  });
  await choice(page, "next", "navigate").click();
  await expect(choice(page, "next", "new-chat")).toBeVisible({
    timeout: 10_000,
  });
  await choice(page, "next", "new-chat").click();

  // The wrap-up offers Done + Restart; Done completes the tour.
  await expect(choice(page, "next", "done")).toBeVisible({ timeout: 10_000 });
  await expect(choice(page, "restart", "done")).toBeVisible();
  await shot("03-wrap-up.png");
  await choice(page, "next", "done").click();
  await expect
    .poll(() => tutorialStatus(page), { timeout: 10_000 })
    .toBe("completed");

  // Narration went through the real voice engine (browser-TTS fallback spy).
  const spoken = await page.evaluate(
    () => (window as unknown as { __ttsSpoken: string[] }).__ttsSpoken,
  );
  expect(spoken.length).toBeGreaterThan(0);
  expect(spoken.join(" ")).toMatch(/tour|chat|mic|settings/i);
});

test("typed stop/restart commands drive the tour from chat", async ({
  page,
}) => {
  // The tour is a chat-native surface — there is no dedicated view. A typed
  // "start tutorial" command in the composer begins it.
  await openAppPath(page, "/chat");
  await expect(page.locator(COMPOSER).first()).toBeVisible({
    timeout: 25_000,
  });
  await expandToFull(page);
  await typeAndSend(page, "start tutorial");
  await expect(choice(page, "next", "welcome")).toBeVisible({
    timeout: 15_000,
  });
  await expect.poll(() => tutorialStatus(page)).toBe("active");

  // "stop tutorial" typed in the composer ends the run with an acknowledgment
  // turn — the text never reaches the agent as a chat message.
  await typeAndSend(page, "stop tutorial");
  await expect(page.getByText(/Tutorial stopped/i)).toBeVisible({
    timeout: 10_000,
  });
  await expect.poll(() => tutorialStatus(page)).toBe("stopped");

  // "restart tutorial" starts a FRESH run: a new, unlocked welcome widget.
  await typeAndSend(page, "restart tutorial");
  await expect.poll(() => tutorialStatus(page)).toBe("active");
  await expect(choice(page, "stop", "welcome").last()).toBeVisible({
    timeout: 10_000,
  });

  // Stopping from the turn's own choice works too.
  await choice(page, "stop", "welcome").last().click();
  await expect.poll(() => tutorialStatus(page)).toBe("stopped");
});

test("normal chat that merely mentions the tutorial is never swallowed", async ({
  page,
}) => {
  await openAppPath(page, "/chat");
  await expect(page.locator(COMPOSER).first()).toBeVisible({
    timeout: 25_000,
  });
  await expandToFull(page);

  // Not an exact command — this must flow to the real send as ordinary chat:
  // no tour starts and no tour ack turn appears.
  await typeAndSend(page, "how do I stop the tutorial?");
  await expect(
    page.getByText("how do I stop the tutorial?").first(),
  ).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1000);
  await expect(page.getByText(/Tutorial stopped/i)).toHaveCount(0);
  expect(await tutorialStatus(page)).not.toBe("active");
});

test("the tour never auto-launches for a fresh user", async ({ page }) => {
  await openAppPath(page, "/chat");
  await expect(page.locator(COMPOSER).first()).toBeVisible({
    timeout: 25_000,
  });
  await page.waitForTimeout(2500);
  await expandToFull(page);
  await expect(choice(page, "next", "welcome")).toHaveCount(0);
  expect(await tutorialStatus(page)).toBeNull();
});
