// Cloud runtime-mode chat coverage for the REAL web chat surface (the
// continuous-chat overlay on /chat). Flips the runtime-mode + cloud-status
// fixtures to "cloud" and proves the overlay still drives a chat turn end to
// end, and that the cloud routing surfaces where it is actually observable in
// the keyless harness (the cloud voice/TTS proxy). Keyless against the stub.
//
// SCOPE NOTE — there is NO distinct client-side "cloud proxy" route for the
// chat SEND in this harness, and asserting one would be a larp. Cloud chat
// routing is achieved two ways, neither of which produces a different chat URL
// the renderer hits:
//   1. Server-side: the remote-mode forwarder
//      (packages/app-core/src/runtime/mode/remote-forwarder.ts) proxies
//      mutations to /api/cloud/v1/* INSIDE the controller process. The ui-smoke
//      stub is a single fake server, so there is no second hop to observe.
//   2. Active-server bridge: a provisioned cloud agent sets the client base URL
//      to the agent's bridgeUrl (client-base.ts setBaseUrl). In
//      cloud-provisioning-startup.spec.ts that bridgeUrl is the test's OWN base
//      (bridgeUrl: apiBase), so even "cloud" chat POSTs the same
//      /api/conversations/<id>/messages/stream path on the same origin.
// The fully provisioned cloud chat path is already covered keyless by
// cloud-provisioning-startup.spec.ts and live by cloud-live.spec.ts. This spec
// covers the remaining, genuinely observable cloud signal: in cloud mode the
// provider defaults resolve to the cloud pipeline, so a voice reply is spoken
// through the cloud TTS proxy (/api/tts/cloud), and the chat send still flows
// through the canonical conversation stream endpoint.

import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';
const TINY_MP3 = Buffer.from(
  "SUQzAwAAAAAAFlRTU0UAAAAMAAADTGF2ZjU4LjI5LjEwMAAA//tQAAAAAAAA",
  "base64",
);

/** Flip the runtime-mode + cloud-status fixtures to a connected cloud runtime. */
async function installCloudRuntimeFixtures(page: Page): Promise<void> {
  await page.unroute("**/api/runtime/mode").catch(() => {});
  await page.route("**/api/runtime/mode", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mode: "cloud",
        deploymentRuntime: "cloud",
        isRemoteController: true,
        remoteApiBaseConfigured: true,
      }),
    });
  });

  await page.unroute("**/api/cloud/status").catch(() => {});
  await page.route("**/api/cloud/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connected: true,
        enabled: true,
        cloudVoiceProxyAvailable: true,
        hasApiKey: true,
        userId: "ui-smoke-cloud-user",
      }),
    });
  });

  await page.route("**/api/cloud/credits", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        balance: 100,
        low: false,
        critical: false,
        authRejected: false,
      }),
    });
  });
}

async function installConversationStreamMock(page: Page): Promise<{
  cloudStreamCount: () => number;
}> {
  let created = false;
  let count = 0;
  const messages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    timestamp: number;
  }> = [];

  await page.route("**/api/conversations", async (route) => {
    const method = route.request().method();
    const timestamp = new Date().toISOString();
    const record = {
      id: "cloud-conversation",
      roomId: "cloud-room",
      title: "Cloud chat smoke",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversations: created ? [record] : [] }),
      });
      return;
    }
    if (method === "POST") {
      created = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversation: record }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route(
    "**/api/conversations/cloud-conversation/messages",
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
    "**/api/conversations/cloud-conversation/messages/stream",
    async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        text?: string;
      };
      count += 1;
      const userText = (body.text ?? "").trim() || "cloud turn";
      const assistantText = "Cloud-routed reply.";
      messages.push({
        id: `cloud-user-${count}`,
        role: "user",
        text: userText,
        timestamp: Date.now(),
      });
      messages.push({
        id: `cloud-assistant-${count}`,
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
    "**/api/conversations/cloud-conversation/greeting**",
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

  await page.route("**/api/conversations/cloud-conversation", async (route) => {
    if (route.request().method() === "PATCH") {
      const timestamp = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversation: {
            id: "cloud-conversation",
            roomId: "cloud-room",
            title: "Cloud chat smoke",
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        }),
      });
      return;
    }
    await route.fallback();
  });

  return { cloudStreamCount: () => count };
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await installCloudRuntimeFixtures(page);
});

test("chat overlay: in cloud runtime mode a send flows through the conversation stream endpoint", async ({
  page,
}) => {
  const conversations = await installConversationStreamMock(page);

  await openAppPath(page, "/chat");
  await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
    timeout: 60_000,
  });
  const composer = page.locator(CHAT_COMPOSER_SELECTOR).first();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  await composer.fill("route me through the cloud");
  const send = page.getByTestId("chat-composer-action");
  await expect(send).toBeVisible({ timeout: 10_000 });
  await send.click();

  // The user turn and the cloud-routed reply render in-thread, and the send hit
  // the canonical conversation stream endpoint (the cloud routing is server /
  // bridge side — see the scope note at the top of this file).
  await expect(
    page
      .getByTestId("thread-line")
      .filter({ hasText: "route me through the cloud" })
      .first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page
      .getByTestId("thread-line")
      .filter({ hasText: "Cloud-routed reply." })
      .first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => conversations.cloudStreamCount()).toBeGreaterThan(0);
});

test("chat overlay: in cloud runtime mode a voice reply is spoken through the cloud TTS proxy", async ({
  page,
}) => {
  await installConversationStreamMock(page);

  // Count the cloud TTS proxy specifically — the observable cloud-routing signal
  // for assistant voice output (cloud provider default -> /api/tts/cloud).
  let cloudTtsCount = 0;
  await page.route("**/api/tts/cloud", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    cloudTtsCount += 1;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "audio/mpeg" },
      body: TINY_MP3,
    });
  });

  // Browser STT shim so a VOICE_DM turn can be driven (assistant voice output is
  // only spoken after a voice turn — see useShellVoiceOutput.ts).
  await page.addInitScript(() => {
    type Listener = (event: unknown) => void;
    const instances: Array<{
      onresult: Listener | null;
      onend: Listener | null;
      onstart: Listener | null;
      started: boolean;
    }> = [];
    function makeRecognition() {
      const rec = {
        onresult: null as Listener | null,
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
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {},
    });
  });

  await openAppPath(page, "/chat");
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });

  const micButton = overlay
    .getByRole("button", { name: /^(talk|voice input)$/i })
    .first();
  await expect(micButton).toBeVisible({ timeout: 15_000 });
  await micButton.click();
  const delivered = await page.evaluate(() => {
    const fn = (window as unknown as Record<string, unknown>).__sttSimulate as
      | ((t: string, f: boolean) => boolean)
      | undefined;
    return fn?.("cloud voice turn", true) ?? false;
  });
  expect(delivered, "voice STT shim must accept a final turn").toBe(true);

  // The cloud-mode voice reply must be spoken through the cloud TTS proxy.
  await expect
    .poll(() => cloudTtsCount, { timeout: 15_000 })
    .toBeGreaterThan(0);
});
