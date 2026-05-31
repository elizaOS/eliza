import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

const SCREENSHOT_DIR = path.join(
  process.cwd(),
  "aesthetic-audit-output",
  "assistant-home-flow",
);

const VIEW_FIXTURES = [
  {
    id: "views-manager",
    label: "Views",
    description: "Browse and launch every available view",
    path: "/views",
    available: true,
    pluginName: "core",
    builtin: true,
    tags: ["launcher"],
    desktopTabEnabled: true,
  },
  {
    id: "terminal",
    label: "Terminal",
    description: "Command-line view for agent work",
    path: "/terminal",
    available: true,
    pluginName: "core",
    builtin: true,
    tags: ["terminal"],
    desktopTabEnabled: true,
  },
  {
    id: "wallet",
    label: "Wallet",
    description: "Wallet inventory and actions",
    path: "/wallet",
    available: true,
    pluginName: "wallet",
    tags: ["wallet"],
    desktopTabEnabled: true,
  },
];

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

async function installAssistantFlowRoutes(page: Page): Promise<{
  streamRequests: string[];
}> {
  await installDefaultAppRoutes(page);
  let conversationCreated = false;
  let messageSequence = 0;
  const streamRequests: string[] = [];
  const messages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    timestamp: number;
  }> = [];
  await page.route("**/api/views**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/views/search") {
      await fulfillJson(route, { results: VIEW_FIXTURES });
      return;
    }
    await fulfillJson(route, { views: VIEW_FIXTURES });
  });
  await page.route("**/api/chat/**", async (route) => {
    await fulfillJson(route, {
      success: true,
      id: "assistant-flow-message",
      text: "Opening the right view now.",
    });
  });
  await page.route("**/api/conversations", async (route) => {
    const method = route.request().method();
    const timestamp = new Date().toISOString();
    if (method === "GET") {
      await fulfillJson(route, {
        conversations: conversationCreated
          ? [
              {
                id: "assistant-home-conversation",
                roomId: "assistant-home-room",
                title: "Assistant home",
                updatedAt: timestamp,
                createdAt: timestamp,
              },
            ]
          : [],
      });
      return;
    }
    if (method === "POST") {
      conversationCreated = true;
      await fulfillJson(route, {
        conversation: {
          id: "assistant-home-conversation",
          roomId: "assistant-home-room",
          title: "Assistant home",
          updatedAt: timestamp,
          createdAt: timestamp,
        },
      });
      return;
    }
    await route.fallback();
  });
  await page.route(
    "**/api/conversations/assistant-home-conversation/messages",
    async (route) => {
      if (route.request().method() === "GET") {
        await fulfillJson(route, { messages });
        return;
      }
      await route.fallback();
    },
  );
  await page.route(
    "**/api/conversations/assistant-home-conversation/messages/stream",
    async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        text?: string;
      };
      const userText = body.text?.trim() || "voice test";
      streamRequests.push(userText);
      const assistantText =
        "I heard you. Opening the right view now and keeping voice ready.";
      const now = Date.now();
      messageSequence += 1;
      messages.push(
        {
          id: `user-${messageSequence}`,
          role: "user",
          text: userText,
          timestamp: now,
        },
        {
          id: `assistant-${messageSequence}`,
          role: "assistant",
          text: assistantText,
          timestamp: now + 1,
        },
      );
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `data: ${JSON.stringify({
            type: "token",
            text: "I heard you.",
            fullText: "I heard you.",
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
    "**/api/conversations/assistant-home-conversation/greeting**",
    async (route) => {
      await fulfillJson(route, {
        text: "Ready when you are.",
        localInference: null,
      });
    },
  );
  await page.route("**/api/turns/assistant-home-room/abort", async (route) => {
    await fulfillJson(route, {
      aborted: true,
      roomId: "assistant-home-room",
      reason: "ui-chat-abort",
    });
  });
  await page.route(
    "**/api/conversations/assistant-home-conversation",
    async (route) => {
      if (route.request().method() === "PATCH") {
        const timestamp = new Date().toISOString();
        await fulfillJson(route, {
          conversation: {
            id: "assistant-home-conversation",
            roomId: "assistant-home-room",
            title: "Assistant home",
            updatedAt: timestamp,
            createdAt: timestamp,
          },
        });
        return;
      }
      await route.fallback();
    },
  );

  return { streamRequests };
}

async function screenshot(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    fullPage: false,
    attempts: 4,
  });
}

async function installHomeSpeechRecognitionShim(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type ResultHandler = (event: unknown) => void;
    const instances: Array<{
      onresult: ResultHandler | null;
      onend: (() => void) | null;
      started: boolean;
      stop: () => void;
    }> = [];

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {},
    });

    function makeRecognition() {
      const rec = {
        continuous: false,
        interimResults: false,
        lang: "en-US",
        onresult: null as ResultHandler | null,
        onerror: null as ResultHandler | null,
        onend: null as (() => void) | null,
        started: false,
        start() {
          this.started = true;
        },
        stop() {
          this.started = false;
          this.onend?.();
        },
        abort() {
          this.stop();
        },
      };
      instances.push(rec);
      return rec;
    }

    (
      window as unknown as { webkitSpeechRecognition: unknown }
    ).webkitSpeechRecognition = makeRecognition;
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition =
      makeRecognition;
    (window as unknown as Record<string, unknown>).__homeVoiceSimulate = (
      text: string,
      isFinal: boolean,
    ) => {
      const rec = instances[instances.length - 1];
      if (!rec?.started) return false;
      rec.onresult?.({
        resultIndex: 0,
        results: [
          {
            isFinal,
            0: { transcript: text },
          },
        ],
      });
      return true;
    };
  });
}

test.describe("assistant home app flow", () => {
  test.beforeEach(({ page }) => {
    installPageDiagnosticsGuard(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await expectNoPageDiagnostics(page, testInfo.title);
  });

  test("captures first-run, assistant home, chat suppression, and view pill states", async ({
    page,
  }) => {
    await rm(SCREENSHOT_DIR, { force: true, recursive: true });
    await installAssistantFlowRoutes(page);

    await page.addInitScript(() => {
      const clearKey = "eliza:ui-smoke:first-run-clear-done";
      if (sessionStorage.getItem(clearKey) !== "1") {
        localStorage.clear();
        sessionStorage.clear();
        sessionStorage.setItem(clearKey, "1");
      }
      localStorage.setItem("eliza:voice:prefix-done", "1");
    });
    await page.route("**/api/first-run/status", async (route) => {
      await fulfillJson(route, { complete: false, cloudProvisioned: false });
    });
    await openAppPath(page, "/");
    await expect(
      page.getByRole("heading", { name: /^Where (should|is)\b/ }),
    ).toBeVisible();
    await screenshot(page, "01-first-run-clouds");

    await page.unroute("**/api/first-run/status");
    await seedAppStorage(page);
    await page.evaluate(() => {
      localStorage.setItem("eliza:first-run-complete", "1");
      localStorage.setItem("eliza:setup:step", "activate");
      localStorage.setItem("eliza:ui-shell-mode", "native");
      localStorage.setItem(
        "elizaos:active-server",
        JSON.stringify({
          id: "local:embedded",
          kind: "local",
          label: "This device",
        }),
      );
    });
    const assistantApi = await installAssistantFlowRoutes(page);

    await openAppPath(page, "/");
    await expect(page.getByTestId("home-view")).toBeVisible();
    const homeChatInput = page.getByTestId("home-chat-input");
    if (!(await homeChatInput.isVisible())) {
      await page.getByTestId("home-chat-pill").click();
    }
    await expect(homeChatInput).toBeVisible();
    await expect(page.getByTestId("shell-home-pill")).toHaveCount(0);
    await screenshot(page, "02-assistant-home-clouds");

    await homeChatInput.fill("show me my views");
    const recentChats = page.getByTestId("home-recent-chats");
    if ((await recentChats.count()) > 0) {
      await expect(recentChats).toBeVisible();
    } else {
      await expect(homeChatInput).toHaveValue("show me my views");
    }
    await screenshot(page, "03-assistant-home-typing-recents");

    await openAppPath(page, "/chat");
    await expect(
      page.locator('[data-testid="chat-composer-textarea"]'),
    ).toBeVisible();
    await expect(page.getByTestId("shell-home-pill")).toHaveCount(0);
    await screenshot(page, "04-chat-pill-suppressed");

    await openAppPath(page, "/views");
    await expect(page.getByText("Views").first()).toBeVisible();
    await expect(page.getByTestId("shell-home-pill")).toBeVisible();
    await screenshot(page, "05-views-with-pill");

    await page.getByTestId("shell-home-pill").click();
    await expect(page.getByTestId("shell-assistant-overlay")).toBeVisible();
    await expect(page.getByLabel("Message Eliza")).toBeVisible();
    await expect(page.getByTestId("shell-home-pill")).toHaveAttribute(
      "aria-label",
      "Close Eliza",
    );

    await page.getByLabel("Message Eliza").fill("open wallet from the pill");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByLabel("Message Eliza")).toHaveValue("");
    await expect(page.getByText("open wallet from the pill")).toBeVisible();
    await expect(page.getByText("I heard you.")).toBeVisible();
    await expect(
      page.getByText("Opening the right view now and keeping voice ready."),
    ).toBeVisible();
    expect(assistantApi.streamRequests).toEqual(["open wallet from the pill"]);
    await screenshot(page, "06-views-pill-open");

    await page.getByTestId("shell-home-pill").click();
    await expect(page.getByTestId("shell-assistant-overlay")).toHaveCount(0);
    await expect(page.getByLabel("Message Eliza")).toHaveCount(0);
    await expect(page.getByTestId("shell-home-pill")).toHaveAttribute(
      "aria-label",
      "Open Eliza",
    );
    await screenshot(page, "06b-views-pill-closed");

    await page.getByTestId("shell-home-pill").click();
    await expect(page.getByTestId("shell-assistant-overlay")).toBeVisible();
    await expect(page.getByLabel("Message Eliza")).toBeVisible();
    await expect(page.getByTestId("shell-home-pill")).toHaveAttribute(
      "aria-label",
      "Close Eliza",
    );
    await screenshot(page, "06c-views-pill-reopened");

    await page.getByLabel("Message Eliza").fill("open terminal after reopen");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByLabel("Message Eliza")).toHaveValue("");
    await expect(page.getByText("open terminal after reopen")).toBeVisible();
    await expect(page.getByText("I heard you.").last()).toBeVisible();
    await expect(
      page
        .getByText("Opening the right view now and keeping voice ready.")
        .last(),
    ).toBeVisible();
    expect(assistantApi.streamRequests).toEqual([
      "open wallet from the pill",
      "open terminal after reopen",
    ]);
    await screenshot(page, "06d-views-pill-second-send");

    await page.getByTestId("shell-home-pill").click();
    await expect(page.getByTestId("shell-assistant-overlay")).toHaveCount(0);
    await expect(page.getByLabel("Message Eliza")).toHaveCount(0);
    await expect(page.getByTestId("shell-home-pill")).toHaveAttribute(
      "aria-label",
      "Open Eliza",
    );
    await screenshot(page, "06e-views-pill-reclosed");

    await openAppPath(page, "/wallet");
    await expect(page.getByTestId("shell-home-pill")).toBeVisible();
    await screenshot(page, "07-wallet-view-with-pill");
  });

  test("drives the assistant home voice path with a scripted browser STT turn", async ({
    page,
  }) => {
    await seedAppStorage(page);
    await installHomeSpeechRecognitionShim(page);
    const assistantApi = await installAssistantFlowRoutes(page);

    await openAppPath(page, "/");
    await expect(page.getByTestId("home-view")).toBeVisible();

    await page
      .getByRole("button", { name: /start voice input/i })
      .click({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: /stop voice input/i }),
    ).toBeVisible();

    const accepted = await page.evaluate(() => {
      const simulate = (
        window as unknown as {
          __homeVoiceSimulate?: (text: string, isFinal: boolean) => boolean;
        }
      ).__homeVoiceSimulate;
      return simulate?.("show me my pinned views", true) ?? false;
    });
    expect(accepted, "home voice shim must receive the scripted turn").toBe(
      true,
    );

    await expect(page.getByTestId("home-assistant-transcript")).toContainText(
      "Opening the right view now and keeping voice ready",
    );
    expect(assistantApi.streamRequests).toEqual(["show me my pinned views"]);
  });

  test("morphs the home mic into send and submits a typed turn", async ({
    page,
  }) => {
    await seedAppStorage(page);
    const assistantApi = await installAssistantFlowRoutes(page);

    await openAppPath(page, "/");
    await expect(page.getByTestId("home-view")).toBeVisible();

    // The trailing control defaults to the mic; there is no send button until
    // the user types into the composer.
    await expect(
      page.getByRole("button", { name: /start voice input/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toHaveCount(0);

    await page.getByTestId("home-chat-input").fill("open wallet by typing");

    // Typing morphs the single trailing control from mic into send.
    await expect(
      page.getByRole("button", { name: /start voice input/i }),
    ).toHaveCount(0);
    const send = page.getByRole("button", { name: "Send message" });
    await expect(send).toBeVisible();

    await send.click();
    await expect(page.getByTestId("home-chat-input")).toHaveValue("");
    await expect(
      page.getByText("Opening the right view now and keeping voice ready."),
    ).toBeVisible();
    expect(assistantApi.streamRequests).toEqual(["open wallet by typing"]);
  });

  test("push-to-talk records while the mic is held and submits on release", async ({
    page,
  }) => {
    await seedAppStorage(page);
    await installHomeSpeechRecognitionShim(page);
    const assistantApi = await installAssistantFlowRoutes(page);

    await openAppPath(page, "/");
    await expect(page.getByTestId("home-view")).toBeVisible();

    const mic = page.getByRole("button", { name: /start voice input/i });
    const box = await mic.boundingBox();
    if (!box) throw new Error("home mic button has no bounding box");

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Holding past the push-to-talk threshold (200ms) begins capture, which
    // flips the trailing control into its "stop" state.
    await expect(
      page.getByRole("button", { name: /stop voice input/i }),
    ).toBeVisible({ timeout: 5_000 });

    const accepted = await page.evaluate(() => {
      const simulate = (
        window as unknown as {
          __homeVoiceSimulate?: (text: string, isFinal: boolean) => boolean;
        }
      ).__homeVoiceSimulate;
      return simulate?.("push to talk works", true) ?? false;
    });
    expect(accepted, "home voice shim must receive the held turn").toBe(true);

    // Releasing the hold ends capture and submits the buffered transcript.
    await page.mouse.up();
    await expect(page.getByTestId("home-assistant-transcript")).toContainText(
      "Opening the right view now and keeping voice ready",
    );
    expect(assistantApi.streamRequests).toEqual(["push to talk works"]);
  });
});
