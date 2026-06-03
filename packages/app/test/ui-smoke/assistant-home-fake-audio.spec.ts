import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const FAKE_AUDIO_DIR = path.join(process.cwd(), "test-results", "fixtures");
const FAKE_AUDIO_PATH = path.join(FAKE_AUDIO_DIR, "assistant-home-script.wav");
const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';
const CHAT_SEND_SELECTOR =
  '[data-testid="chat-composer-action"], button[aria-label="send"], button[aria-label="Send"], button[aria-label="Send message"]';

test.skip(true, "The legacy assistant home surface was removed; / now lands on chat.");

function pcm16WavTone(): Buffer {
  const sampleRate = 48_000;
  const seconds = 1.2;
  const samples = Math.floor(sampleRate * seconds);
  const dataBytes = samples * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples; index += 1) {
    const sample = Math.sin((index / sampleRate) * 2 * Math.PI * 440) * 0.35;
    out.writeInt16LE(Math.round(sample * 0x7fff), 44 + index * 2);
  }
  return out;
}

mkdirSync(FAKE_AUDIO_DIR, { recursive: true });
writeFileSync(FAKE_AUDIO_PATH, pcm16WavTone());

test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${FAKE_AUDIO_PATH}`,
    ],
  },
});

async function fulfillJson(
  route: Route,
  body: Record<string, unknown>,
): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installFakeAudioHomeRoutes(page: Page): Promise<{
  asrCalls: () => number[];
  streamedPrompts: () => string[];
}> {
  await installDefaultAppRoutes(page);
  const asrBodies: number[] = [];
  const prompts: string[] = [];
  const timestamp = new Date().toISOString();
  const conversation = {
    id: "fake-audio-conversation",
    roomId: "fake-audio-room",
    title: "Fake audio",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const messages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    timestamp: number;
  }> = [];

  await page.route("**/api/asr/local-inference", async (route) => {
    const body = route.request().postDataBuffer();
    asrBodies.push(body?.byteLength ?? 0);
    await fulfillJson(route, { text: "show me my views from fake audio" });
  });

  await page.route("**/api/config", async (route) => {
    if (route.request().method() === "GET") {
      await fulfillJson(route, {
        messages: {
          tts: {
            provider: "local-inference",
            asr: { provider: "local-inference" },
          },
        },
      });
      return;
    }
    if (route.request().method() === "PUT") {
      await fulfillJson(route, { ok: true });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() === "POST") {
      await fulfillJson(route, { conversation });
      return;
    }
    if (route.request().method() === "GET") {
      await fulfillJson(route, { conversations: [conversation] });
      return;
    }
    await route.fallback();
  });

  await page.route(
    "**/api/conversations/fake-audio-conversation/messages",
    async (route) => {
      if (route.request().method() === "GET") {
        await fulfillJson(route, { messages });
        return;
      }
      await route.fallback();
    },
  );

  await page.route(
    "**/api/conversations/fake-audio-conversation/messages/stream",
    async (route) => {
      const payload = JSON.parse(route.request().postData() ?? "{}") as {
        text?: string;
      };
      prompts.push(payload.text ?? "");
      const assistantText =
        "I heard the local microphone capture and can open your views.";
      messages.push(
        {
          id: `fake-audio-user-${messages.length + 1}`,
          role: "user",
          text: payload.text ?? "",
          timestamp: Date.now(),
        },
        {
          id: `fake-audio-assistant-${messages.length + 2}`,
          role: "assistant",
          text: assistantText,
          timestamp: Date.now(),
        },
      );
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `data: ${JSON.stringify({
            type: "token",
            text: "I heard the local microphone capture",
            fullText: "I heard the local microphone capture",
          })}\n\n` +
          `data: ${JSON.stringify({
            type: "done",
            fullText: assistantText,
            agentName: "Eliza",
          })}\n\n`,
      });
    },
  );

  await page.route("**/api/turns/fake-audio-room/abort", async (route) => {
    await fulfillJson(route, {
      aborted: true,
      roomId: "fake-audio-room",
      reason: "ui-chat-abort",
    });
  });

  return {
    asrCalls: () => [...asrBodies],
    streamedPrompts: () => [...prompts],
  };
}

async function installScriptedMicrophoneStream(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        async getUserMedia() {
          const AudioCtor =
            window.AudioContext ??
            (
              window as unknown as {
                webkitAudioContext?: typeof AudioContext;
              }
            ).webkitAudioContext;
          if (!AudioCtor) {
            throw new Error("AudioContext unavailable for scripted mic");
          }
          const context = new AudioCtor();
          const destination = context.createMediaStreamDestination();
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = "sine";
          oscillator.frequency.value = 440;
          gain.gain.value = 0.25;
          oscillator.connect(gain);
          gain.connect(destination);
          oscillator.start();
          const stop = () => {
            try {
              oscillator.stop();
            } catch {
              /* already stopped */
            }
            void context.close().catch(() => {});
          };
          for (const track of destination.stream.getTracks()) {
            track.addEventListener("ended", stop, { once: true });
          }
          return destination.stream;
        },
      },
    });
  });
}

function conversationLog(page: Page) {
  return page.getByRole("log", { name: /conversation history/i });
}

function conversationText(page: Page, text: string | RegExp) {
  return page
    .locator('[data-testid="chat-message"]')
    .filter({ hasText: text })
    .last()
    .or(conversationLog(page).getByText(text).last())
    .first();
}

test("assistant chat captures fake microphone audio through local ASR and replies", async ({
  page,
}) => {
  await seedAppStorage(page, {
    "eliza:mobile-runtime-mode": "local",
  });
  await installScriptedMicrophoneStream(page);
  const calls = await installFakeAudioHomeRoutes(page);

  await openAppPath(page, "/chat");
  const composer = page.locator(CHAT_COMPOSER_SELECTOR).first();
  await expect(composer).toBeEnabled();

  const mic = page
    .locator('[data-chat-composer="true"] button[aria-pressed]')
    .or(page.getByRole("button", { name: /talk|voice input/i }))
    .first();
  await expect(mic).toBeVisible();
  await expect(mic).toBeEnabled();
  await mic.click();
  const stopMic = page.getByRole("button", { name: /stop listening/i });
  await expect(stopMic).toBeVisible();
  await page.waitForTimeout(900);
  await stopMic.click();

  await expect
    .poll(() => calls.streamedPrompts(), {
      message: "local ASR transcript should be submitted as a voice turn",
      timeout: 30_000,
    })
    .toContain("show me my views from fake audio");
  const expandConversation = page.getByRole("button", {
    name: /expand conversation/i,
  });
  await expect(expandConversation).toBeVisible();
  await expandConversation.click();
  await expect(conversationLog(page)).toBeVisible();
  await expect(conversationText(page, "show me my views from fake audio")).toBeVisible();
  await expect(
    conversationText(page, "local microphone capture and can open your views"),
  ).toBeVisible();
  await expect(composer).toHaveValue("");
  await expect
    .poll(() => calls.asrCalls()[0] ?? 0, {
      message: "local ASR endpoint should receive captured WAV audio",
    })
    .toBeGreaterThan(44);
});
