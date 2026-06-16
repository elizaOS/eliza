// Assistant-voice mute coverage for the REAL web chat surface (the
// continuous-chat overlay on /chat). Proves the overlay's `chat-voice-mute`
// control gates assistant TTS output: a voice turn speaks (POSTs /api/tts/*),
// muting suppresses the next turn's TTS, and unmuting resumes it. Keyless
// against the stub.
//
// Surface notes (verified against source, load-bearing for the asserts):
//   * useShellVoiceOutput.ts speaks the latest assistant reply ONLY after a
//     VOICE_DM turn (lastTurnVoice) and only while not muted — a typed turn
//     stays silent. So this spec drives VOICE turns via the browser STT shim.
//   * The mute control (testId chat-voice-mute) is mounted only while
//     `speaking || agentVoiceMuted` (ContinuousChatOverlay.tsx) — it appears
//     while the reply is being spoken and stays visible once muted.
//   * queueAssistantSpeech for the web/local provider default (elevenlabs)
//     POSTs /api/tts/cloud (tried first) then falls back to /api/tts/elevenlabs
//     (useVoiceChat.ts). The TTS POST is a network signal independent of
//     headless audio playback, so it is the durable mute assertion.

import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';

// A tiny but well-formed silent mp3 frame so the cloud-TTS mock returns a
// decodable audio body (decodeAudioData rejects truly-empty bodies).
const TINY_MP3 = Buffer.from(
  "SUQzAwAAAAAAFlRTU0UAAAAMAAADTGF2ZjU4LjI5LjEwMAAA//tQAAAAAAAA",
  "base64",
);

async function installConversationStreamMock(page: Page): Promise<void> {
  let created = false;
  const messages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    timestamp: number;
  }> = [];
  let sequence = 0;

  await page.route("**/api/conversations", async (route) => {
    const method = route.request().method();
    const timestamp = new Date().toISOString();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversations: created
            ? [
                {
                  id: "voice-conversation",
                  roomId: "voice-room",
                  title: "Voice mute smoke",
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
              ]
            : [],
        }),
      });
      return;
    }
    if (method === "POST") {
      created = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversation: {
            id: "voice-conversation",
            roomId: "voice-room",
            title: "Voice mute smoke",
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route(
    "**/api/conversations/voice-conversation/messages",
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ messages }),
        });
        return;
      }
      await route.fallback();
    },
  );

  await page.route(
    "**/api/conversations/voice-conversation/messages/stream",
    async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        text?: string;
      };
      const userText = (body.text ?? "").trim() || "voice turn";
      sequence += 1;
      const assistantText = `Spoken reply number ${sequence}.`;
      messages.push({
        id: `voice-user-${sequence}`,
        role: "user",
        text: userText,
        timestamp: Date.now(),
      });
      messages.push({
        id: `voice-assistant-${sequence}`,
        role: "assistant",
        text: assistantText,
        timestamp: Date.now(),
      });
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `data: ${JSON.stringify({
            type: "token",
            text: assistantText,
            fullText: assistantText,
          })}\n\n` +
          `data: ${JSON.stringify({
            type: "done",
            fullText: assistantText,
            agentName: "Eliza",
          })}\n\n`,
      });
    },
  );

  await page.route(
    "**/api/conversations/voice-conversation/greeting**",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          text: "Ready when you are.",
          localInference: null,
        }),
      });
    },
  );

  await page.route("**/api/conversations/voice-conversation", async (route) => {
    if (route.request().method() === "PATCH") {
      const timestamp = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversation: {
            id: "voice-conversation",
            roomId: "voice-room",
            title: "Voice mute smoke",
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        }),
      });
      return;
    }
    await route.fallback();
  });
}

/** Mock + COUNT every /api/tts/* POST so mute can be asserted by call deltas. */
async function installTtsCountingMock(page: Page): Promise<{
  ttsPostCount: () => number;
}> {
  let count = 0;
  for (const pattern of [
    "**/api/tts/cloud",
    "**/api/tts/elevenlabs",
    "**/api/tts/local-inference",
  ]) {
    await page.route(pattern, async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      count += 1;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "audio/mpeg" },
        body: TINY_MP3,
      });
    });
  }
  return { ttsPostCount: () => count };
}

/** Browser SpeechRecognition shim exposing window.__sttSimulate(text, final). */
async function installSpeechRecognitionShim(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Listener = (event: unknown) => void;
    const instances: Array<{
      onresult: Listener | null;
      onerror: Listener | null;
      onend: Listener | null;
      onstart: Listener | null;
      continuous: boolean;
      interimResults: boolean;
      lang: string;
      started: boolean;
    }> = [];

    function makeRecognition() {
      const rec = {
        onresult: null as Listener | null,
        onerror: null as Listener | null,
        onend: null as Listener | null,
        onstart: null as Listener | null,
        continuous: false,
        interimResults: false,
        lang: "en-US",
        started: false,
        start() {
          this.started = true;
          this.onstart?.({});
        },
        stop() {
          this.started = false;
          this.onend?.({});
        },
        abort() {
          this.started = false;
          this.onend?.({});
        },
        addEventListener(name: string, handler: Listener) {
          if (name === "result") this.onresult = handler;
          if (name === "error") this.onerror = handler;
          if (name === "end") this.onend = handler;
          if (name === "start") this.onstart = handler;
        },
        removeEventListener() {},
      };
      instances.push(rec);
      return rec;
    }

    (
      window as unknown as { webkitSpeechRecognition: unknown }
    ).webkitSpeechRecognition = makeRecognition;
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition =
      makeRecognition;

    (window as unknown as Record<string, unknown>).__sttSimulate = (
      transcript: string,
      isFinal: boolean,
    ) => {
      const rec = instances[instances.length - 1];
      if (!rec?.started) return false;
      rec.onresult?.({
        resultIndex: 0,
        results: [{ isFinal, 0: { transcript }, length: 1 }],
      });
      return true;
    };
  });
}

async function forceBrowserSpeechRecognition(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {},
    });
  });
}

/** Open the overlay mic, then feed a final voice transcript (a VOICE_DM turn). */
async function speakVoiceTurn(page: Page, transcript: string): Promise<void> {
  const overlay = page.getByTestId("continuous-chat-overlay");
  const micButton = overlay
    .getByRole("button", { name: /^(talk|voice input)$/i })
    .first();
  await expect(micButton).toBeVisible({ timeout: 15_000 });
  await micButton.click();
  const delivered = await page.evaluate((text) => {
    const fn = (window as unknown as Record<string, unknown>).__sttSimulate as
      | ((t: string, f: boolean) => boolean)
      | undefined;
    return fn?.(text, true) ?? false;
  }, transcript);
  expect(delivered, "voice STT shim must accept a final turn").toBe(true);
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await installConversationStreamMock(page);
  await installSpeechRecognitionShim(page);
  await forceBrowserSpeechRecognition(page);
});

test("chat overlay: mute suppresses assistant TTS and unmute resumes it", async ({
  page,
}) => {
  const tts = await installTtsCountingMock(page);

  await openAppPath(page, "/chat");
  await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator(CHAT_COMPOSER_SELECTOR).first()).toBeVisible({
    timeout: 15_000,
  });

  // Turn 1 (unmuted): a voice turn must drive assistant TTS output.
  await speakVoiceTurn(page, "first voice turn");
  await expect
    .poll(() => tts.ttsPostCount(), { timeout: 15_000 })
    .toBeGreaterThan(0);

  // The mute control is revealed while the reply is being spoken. Mute it.
  const muteButton = page.getByTestId("chat-voice-mute");
  await expect(muteButton).toBeVisible({ timeout: 15_000 });
  await muteButton.click();
  // Once muted, the same control stays mounted (agentVoiceMuted) as "unmute".
  await expect(muteButton).toHaveAttribute("aria-pressed", "true", {
    timeout: 10_000,
  });

  // Turn 2 (muted): no NEW TTS POST may fire.
  const countAfterMute = tts.ttsPostCount();
  await speakVoiceTurn(page, "second voice turn while muted");
  // Let the stream + voice-output effect settle, then assert no TTS was sent.
  await expect(page.getByText("Spoken reply number 2.").first()).toBeVisible({
    timeout: 15_000,
  });
  expect(
    tts.ttsPostCount(),
    "muted assistant voice must not POST /api/tts/*",
  ).toBe(countAfterMute);

  // Unmute and drive a third turn — TTS resumes.
  await muteButton.click();
  await expect(muteButton).toHaveAttribute("aria-pressed", "false", {
    timeout: 10_000,
  });
  const countBeforeResume = tts.ttsPostCount();
  await speakVoiceTurn(page, "third voice turn after unmute");
  await expect
    .poll(() => tts.ttsPostCount(), { timeout: 15_000 })
    .toBeGreaterThan(countBeforeResume);
});
