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

const TINY_MP3 = Buffer.from(
  "SUQzAwAAAAAAFlRTU0UAAAAMAAADTGF2ZjU4LjI5LjEwMAAA//tQAAAAAAAA",
  "base64",
);

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
  await page.route("**/api/config", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      cloud: { enabled: false },
      media: {},
      plugins: { entries: {} },
      ui: { avatarIndex: 1 },
      wallet: {},
    });
  });
  await page.route("**/api/stream/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, { settings: { avatarIndex: 1 } });
  });
  await page.route("**/api/agent/events**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      events: [],
      latestEventId: null,
      totalBuffered: 0,
      replayed: true,
    });
  });
  await page.route("**/api/local-inference/hub", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const emptyDownload = {
      state: "idle",
      percent: null,
      etaMs: null,
      bytesDownloaded: 0,
      bytesTotal: 0,
      error: null,
    };
    await fulfillJson(route, {
      catalog: [],
      installed: [],
      active: {
        modelId: null,
        loaded: false,
        status: "idle",
        error: null,
        updatedAt: new Date(0).toISOString(),
      },
      downloads: [],
      hardware: { status: "unsupported" },
      assignments: {},
      textReadiness: {
        updatedAt: new Date(0).toISOString(),
        slots: {
          TEXT_SMALL: {
            slot: "TEXT_SMALL",
            assigned: false,
            assignedModelId: null,
            displayName: null,
            primaryDownloaded: false,
            downloaded: false,
            active: false,
            ready: false,
            state: "unassigned",
            requiredModelIds: [],
            missingModelIds: [],
            installedBytes: 0,
            expectedBytes: 0,
            download: emptyDownload,
            errors: [],
          },
          TEXT_LARGE: {
            slot: "TEXT_LARGE",
            assigned: false,
            assignedModelId: null,
            displayName: null,
            primaryDownloaded: false,
            downloaded: false,
            active: false,
            ready: false,
            state: "unassigned",
            requiredModelIds: [],
            missingModelIds: [],
            installedBytes: 0,
            expectedBytes: 0,
            download: emptyDownload,
            errors: [],
          },
        },
      },
    });
  });
  await page.route(
    "**/api/local-inference/downloads/stream**",
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "",
      });
    },
  );
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
  await page.route("**/api/tts/**", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "audio/mpeg" },
      body: TINY_MP3,
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

async function openReadyChat(page: Page, targetPath = "/"): Promise<void> {
  await openAppPath(page, targetPath);
  await expect(page.getByTestId("startup-shell-loading")).toHaveCount(0);
  const composer = page.locator('[data-testid="chat-composer-textarea"]');
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await expect(composer).toBeEnabled({ timeout: 30_000 });
}

async function openReadyChatWorkspace(page: Page): Promise<void> {
  await openReadyChat(page, "/chat");
  await expect(
    page.getByRole("region", { name: "Chat workspace" }),
  ).toBeVisible({ timeout: 15_000 });
}

async function installReadyDesktopStatusBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Bridge = {
      request?: Record<string, (params?: unknown) => Promise<unknown>>;
      onMessage?: (
        messageName: string,
        listener: (payload: unknown) => void,
      ) => void;
      offMessage?: (
        messageName: string,
        listener: (payload: unknown) => void,
      ) => void;
    };
    const win = window as Window & { __ELIZA_ELECTROBUN_RPC__?: Bridge };
    const existing = win.__ELIZA_ELECTROBUN_RPC__;
    const now = Date.now();
    const readyStatus = {
      state: "running",
      agentName: "Playwright Smoke",
      model: "ui-smoke",
      uptime: 60_000,
      startedAt: now - 60_000,
      pendingRestart: false,
      pendingRestartReasons: [],
      startup: { phase: "running", attempt: 0 },
    };
    const readyLaunch = {
      phase: "ready",
      agent: {
        state: "running",
        port: null,
        apiBase: null,
        startedAt: now - 60_000,
        error: null,
      },
      boot: {
        runtimePhase: "running",
        pluginsLoaded: 0,
        pluginsFailed: 0,
        database: "ok",
      },
      auth: { checked: true, required: false },
      firstRun: { checked: true, complete: true, cloudProvisioned: true },
      remotes: { seeded: true, requiredStarted: false, errors: [] },
      localModel: { backgroundDownloadQueued: false, blocking: false },
      diagnostics: { logPath: "", statusPath: "" },
      recovery: {
        canRetry: false,
        canOpenLogs: false,
        canCreateBugReport: false,
      },
      updatedAt: new Date(now).toISOString(),
    };
    const readyBoot = {
      state: "running",
      phase: "running",
      lastError: null,
      pluginsLoaded: 0,
      pluginsFailed: 0,
      database: "ok",
      agentName: "Playwright Smoke",
      port: null,
      startedAt: now - 60_000,
    };
    const withReadyStatus = (bridge?: Bridge): Bridge => ({
      request: {
        ...(bridge?.request ?? {}),
        getAgentStatus: async () => readyStatus,
        launchProgress: async () => readyLaunch,
        bootProgress: async () => readyBoot,
      },
      onMessage: bridge?.onMessage ?? (() => {}),
      offMessage: bridge?.offMessage ?? (() => {}),
    });
    let currentBridge = withReadyStatus(existing);
    Object.defineProperty(win, "__ELIZA_ELECTROBUN_RPC__", {
      configurable: true,
      get() {
        return currentBridge;
      },
      set(nextBridge: Bridge | undefined) {
        currentBridge = withReadyStatus(nextBridge);
      },
    });
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "local:playwright-smoke",
        kind: "local",
        label: "Playwright Smoke",
        apiBase: window.location.origin,
      }),
    );
  });
}

async function installChatSpeechRecognitionShim(page: Page): Promise<void> {
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
      stopCount: number;
    }> = [];

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {},
    });

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
        stopCount: 0,
        start() {
          this.started = true;
          this.onstart?.({});
        },
        stop() {
          this.started = false;
          this.stopCount += 1;
          this.onend?.({});
        },
        abort() {
          this.stop();
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
      text: string,
      isFinal: boolean,
    ) => {
      const rec = instances[instances.length - 1];
      if (!rec?.started) return false;
      rec.onresult?.({
        results: [
          {
            isFinal,
            0: { transcript: text },
            length: 1,
          },
        ],
      });
      return true;
    };
    (window as unknown as Record<string, unknown>).__sttState = () => {
      const rec = instances[instances.length - 1];
      return rec
        ? {
            continuous: rec.continuous,
            interimResults: rec.interimResults,
            lang: rec.lang,
            started: rec.started,
            stopCount: rec.stopCount,
          }
        : null;
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
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#root")).toBeVisible({ timeout: 20_000 });
    await expect(page).not.toHaveURL(/first-run/, { timeout: 12_000 });
    await expect(page.getByTestId("onboarding-toast")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Eliza Cloud" }),
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
    await installReadyDesktopStatusBridge(page);
    const assistantApi = await installAssistantFlowRoutes(page);

    await openReadyChat(page);
    const rootChatInput = page.locator(
      '[data-testid="chat-composer-textarea"]',
    );
    await expect(page.getByTestId("shell-home-pill")).toHaveCount(0);
    await screenshot(page, "02-assistant-chat-root");

    await rootChatInput.fill("show me my views");
    await screenshot(page, "03-assistant-chat-typing");

    await openAppPath(page, "/chat");
    await expect(
      page.locator('[data-testid="chat-composer-textarea"]'),
    ).toBeVisible();
    await expect(page.getByTestId("shell-home-pill")).toHaveCount(0);
    await screenshot(page, "04-chat-pill-suppressed");

    await openAppPath(page, "/views");
    await expect(page.getByText("Views").first()).toBeVisible();
    await expect(page.getByTestId("shell-home-pill")).toHaveCount(0);
    expect(assistantApi.streamRequests).toEqual([]);
    await screenshot(page, "05-views-desktop-no-embedded-pill");

    await openAppPath(page, "/wallet");
    await expect(page.getByTestId("shell-home-pill")).toHaveCount(0);
    await screenshot(page, "07-wallet-view-no-embedded-pill");
  });

  test("drives the assistant home voice path with a scripted browser STT turn", async ({
    page,
  }) => {
    await seedAppStorage(page);
    await installChatSpeechRecognitionShim(page);
    await installAssistantFlowRoutes(page);

    await openReadyChatWorkspace(page);

    const mic = page.getByRole("button", { name: /Voice input/i }).first();
    await expect(mic).toBeEnabled({ timeout: 30_000 });
    await mic.click();
    await expect(
      page.getByRole("button", { name: /Stop listening/i }),
    ).toBeVisible({ timeout: 5_000 });

    const accepted = await page.evaluate(() => {
      const simulate = (
        window as unknown as {
          __sttSimulate?: (text: string, isFinal: boolean) => boolean;
        }
      ).__sttSimulate;
      return simulate?.("show me my pinned views", true) ?? false;
    });
    expect(accepted, "chat voice shim must receive the scripted turn").toBe(
      true,
    );

    await expect(page.getByTestId("chat-composer-textarea")).toHaveValue(
      "show me my pinned views",
      { timeout: 5_000 },
    );
  });

  test("submits a typed turn through the current chat composer", async ({
    page,
  }) => {
    await seedAppStorage(page);
    const assistantApi = await installAssistantFlowRoutes(page);

    await openReadyChatWorkspace(page);

    const initialMic = page
      .getByRole("button", { name: /Voice input/i })
      .first();
    await expect(initialMic).toBeVisible();
    await expect(initialMic).toBeEnabled({ timeout: 15_000 });

    const composer = page.getByTestId("chat-composer-textarea");
    await expect(page.getByRole("button", { name: /^Send$/ })).toHaveCount(0);

    await composer.fill("open wallet by typing");
    const send = page.getByRole("button", { name: /^Send$/ });
    await expect(send).toBeVisible();
    await expect(send).toBeEnabled({ timeout: 15_000 });
    await send.click();
    await expect(composer).toHaveValue("");
    await expect(
      page.getByText("Opening the right view now and keeping voice ready."),
    ).toBeVisible();
    expect(assistantApi.streamRequests).toEqual(["open wallet by typing"]);
  });

  test("push-to-talk records while the mic is held and submits on release", async ({
    page,
  }) => {
    await seedAppStorage(page);
    await installChatSpeechRecognitionShim(page);
    const assistantApi = await installAssistantFlowRoutes(page);

    await openReadyChatWorkspace(page);

    const mic = page.getByRole("button", { name: /Voice input/i }).first();
    await expect(mic).toBeEnabled({ timeout: 15_000 });

    await mic.dispatchEvent("pointerdown", {
      bubbles: true,
      button: 0,
      buttons: 1,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse",
    });
    // Holding past the push-to-talk threshold (200ms) begins capture, which
    // flips the microphone into its release-to-send state.
    await expect(
      page.getByRole("button", { name: /Release to send/i }),
    ).toBeVisible({ timeout: 5_000 });
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const state = (
              window as unknown as {
                __sttState?: () => { started: boolean } | null;
              }
            ).__sttState?.();
            return state?.started ?? false;
          }),
        { timeout: 5_000 },
      )
      .toBe(true);

    const accepted = await page.evaluate(() => {
      const simulate = (
        window as unknown as {
          __sttSimulate?: (text: string, isFinal: boolean) => boolean;
        }
      ).__sttSimulate;
      return simulate?.("push to talk works", true) ?? false;
    });
    expect(accepted, "chat voice shim must receive the held turn").toBe(true);

    // Releasing the hold ends capture and submits the buffered transcript.
    await page
      .getByRole("button", { name: /Release to send/i })
      .dispatchEvent("pointerup", {
        bubbles: true,
        button: 0,
        buttons: 0,
        isPrimary: true,
        pointerId: 1,
        pointerType: "mouse",
      });
    await expect(
      page.getByText("Opening the right view now and keeping voice ready."),
    ).toBeVisible();
    expect(assistantApi.streamRequests).toEqual(["push to talk works"]);
  });
});
