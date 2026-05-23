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

  await page.route("**/api/asr/local-inference", async (route) => {
    const body = route.request().postDataBuffer();
    asrBodies.push(body?.byteLength ?? 0);
    await fulfillJson(route, { text: "show me my views from fake audio" });
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
        await fulfillJson(route, { messages: [] });
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

test("assistant home captures fake microphone audio through local ASR and replies", async ({
  page,
}) => {
  await seedAppStorage(page);
  await installScriptedMicrophoneStream(page);
  const calls = await installFakeAudioHomeRoutes(page);

  await openAppPath(page, "/");
  await expect(page.getByTestId("home-view")).toBeVisible();
  await page.getByRole("button", { name: /start voice input/i }).click();
  await expect(
    page.getByRole("button", { name: /stop voice input/i }),
  ).toBeVisible();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: /stop voice input/i }).click();

  await expect(page.getByTestId("home-assistant-transcript")).toContainText(
    "local microphone capture and can open your views",
  );
  expect(calls.asrCalls()[0]).toBeGreaterThan(44);
  expect(calls.streamedPrompts()).toContain("show me my views from fake audio");
});
