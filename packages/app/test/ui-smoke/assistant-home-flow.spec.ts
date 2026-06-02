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

async function openReadyHome(page: Page): Promise<void> {
  await openAppPath(page, "/");
  await expect(page.getByTestId("home-view")).toBeVisible();
  await expect(
    page.getByRole("status").filter({
      hasText: /Starting Eliza|Loading workspace|Connecting to Eliza/,
    }),
  ).toHaveCount(0, { timeout: 30_000 });

  const homeChatInput = page.getByTestId("home-chat-input");
  if (!(await homeChatInput.isVisible())) {
    const homeChatPill = page.getByTestId("home-chat-pill");
    await expect(homeChatPill).toBeVisible({ timeout: 15_000 });
    await homeChatPill.focus();
    await homeChatPill.press("Enter");
  }
  await expect(homeChatInput).toBeVisible({ timeout: 15_000 });
  await expect(homeChatInput).toBeEnabled({ timeout: 30_000 });

  const mic = page.getByRole("button", { name: /start voice input/i });
  if ((await mic.count()) > 0) {
    await expect(mic).toBeEnabled({ timeout: 30_000 });
  }
}

async function openReadyChat(page: Page, targetPath = "/"): Promise<void> {
  await openAppPath(page, targetPath);
  await expect(page.getByTestId("startup-shell-loading")).toHaveCount(0);
  await expect(page.getByTestId("first-run-shell")).toHaveCount(0);
  const composer = page.locator('[data-testid="chat-composer-textarea"]');
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await expect(composer).toBeEnabled({ timeout: 30_000 });
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
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#root")).toBeVisible({ timeout: 20_000 });
    await expect(page).not.toHaveURL(/first-run/, { timeout: 12_000 });
    await expect(page.getByTestId("first-run-shell")).toBeVisible();
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
    const rootChatInput = page.locator('[data-testid="chat-composer-textarea"]');
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
    await installReadyDesktopStatusBridge(page);
    const assistantApi = await installAssistantFlowRoutes(page);

    await openReadyHome(page);

    const mic = page.getByRole("button", { name: /start voice input/i });
    await expect(mic).toBeEnabled({ timeout: 30_000 });
    await mic.click();
    await expect(page.getByTestId("home-voice-stop")).toBeVisible();

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
    page.on("console", (m) => console.log("PAGE>", m.type(), m.text()));
    page.on("requestfailed", (r) =>
      console.log("REQFAIL>", r.method(), r.url(), r.failure()?.errorText),
    );
    page.on("response", (r) => {
      const u = r.url();
      if (u.includes("/api/conversations") || u.includes("/api/chat"))
        console.log("RESP>", r.status(), r.request().method(), u);
    });
    await seedAppStorage(page);
    await installReadyDesktopStatusBridge(page);
    const assistantApi = await installAssistantFlowRoutes(page);

    await openReadyHome(page);

    // The trailing control defaults to the mic; there is no send button until
    // the user types into the composer.
    const initialMic = page.getByRole("button", {
      name: /start voice input/i,
    });
    await expect(initialMic).toBeVisible();
    await expect(initialMic).toBeEnabled({ timeout: 15_000 });
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
    await expect(send).toBeEnabled({ timeout: 15_000 });

    const cover = await send.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      return {
        topTag: top?.tagName,
        topLabel: top?.getAttribute("aria-label"),
        isSelf: top === el || el.contains(top),
        disabled: (el as HTMLButtonElement).disabled,
      };
    });
    console.log("COVER>", JSON.stringify(cover));
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
    await installReadyDesktopStatusBridge(page);
    const assistantApi = await installAssistantFlowRoutes(page);

    await openReadyHome(page);

    const mic = page.getByRole("button", { name: /start voice input/i });
    await expect(mic).toBeEnabled({ timeout: 15_000 });
    const box = await mic.boundingBox();
    if (!box) throw new Error("home mic button has no bounding box");

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Holding past the push-to-talk threshold (200ms) begins capture, which
    // flips the trailing control into its "stop" state.
    await expect(page.getByTestId("home-voice-stop")).toBeVisible({
      timeout: 5_000,
    });

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
