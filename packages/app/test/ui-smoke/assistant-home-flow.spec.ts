/**
 * Playwright UI-smoke spec for the Assistant Home Flow app flow using the real
 * renderer fixture.
 */
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
import { navigateHomeLauncher } from "./helpers/launcher-navigation";
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
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    timestamp: number;
  }>;
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
  await page.route("**/api/cloud/login", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      ok: true,
      sessionId: "assistant-flow-cloud-login",
      browserUrl:
        "https://www.elizacloud.ai/auth/cli-login?session=assistant-flow-cloud-login",
    });
  });
  await page.route("**/api/cloud/login/status**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      status: "authenticated",
      token: "assistant-flow-cloud-token",
      organizationId: "assistant-flow-org",
      userId: "assistant-flow-user",
    });
  });
  await page.route("**/api/cloud/login/persist", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, { success: true });
  });
  await page.route("**/api/cloud/compat/agents", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, { success: true, data: [] });
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
  await page.route("**/api/tts/{cloud,elevenlabs}", async (route) => {
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
    // Match the base list AND its `?before=<cursor>` pagination (the infinite
    // upward-scroll load, #13532) — the plain `**/messages` glob never matched a
    // query string, so the cursor fetch 404'd. Anchored so it does NOT swallow
    // the `/messages/stream` sub-route registered below.
    /\/api\/conversations\/assistant-home-conversation\/messages(?:\?|$)/,
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      // A `before` cursor asks for older history; this fixture conversation has
      // none, so return an empty page with `hasMore:false` to stop the scroll
      // from refetching the same cursor.
      const hasBeforeCursor = new URL(route.request().url()).searchParams.has(
        "before",
      );
      await fulfillJson(route, {
        messages: hasBeforeCursor ? [] : messages,
        hasMore: false,
      });
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

  return { messages, streamRequests };
}

async function screenshot(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    fullPage: false,
    attempts: 4,
  });
}

function assistantComposer(page: Page) {
  return page
    .getByTestId("chat-composer-textarea")
    .or(page.getByLabel(/^message$/i))
    .first();
}

function assistantMicButton(page: Page) {
  return page
    .getByRole("group", { name: "Chat composer" })
    .getByRole("button", { name: /^(talk|voice input)$/i });
}

function launcherTile(page: Page, viewId: string) {
  return page.getByTestId(`launcher-tile-${viewId}`).first();
}

function conversationLog(page: Page) {
  return page.getByRole("region", { name: /conversation history/i });
}

function conversationText(page: Page, text: string | RegExp) {
  return page
    .locator('[data-testid="chat-message"]')
    .filter({ hasText: text })
    .last()
    .or(page.getByTestId("thread-line").filter({ hasText: text }).last())
    .or(conversationLog(page).getByText(text).last())
    .first();
}

async function openReadyWorkspaceChat(page: Page): Promise<void> {
  await openAppPath(page, "/");
  await expect(
    page.getByRole("status").filter({
      hasText: /Starting Eliza|Loading workspace|Connecting to Eliza/,
    }),
  ).toHaveCount(0, { timeout: 30_000 });

  const composer = assistantComposer(page);
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await expect(composer).toBeEnabled({ timeout: 30_000 });

  const mic = assistantMicButton(page);
  if ((await mic.count()) > 0) {
    await expect(mic).toBeEnabled({ timeout: 30_000 });
  }
}

async function openReadyChat(page: Page, targetPath = "/"): Promise<void> {
  await openAppPath(page, targetPath);
  await expect(page.getByTestId("startup-shell-loading")).toHaveCount(0);
  // When the agent is ready (first-run complete), the floating first-run chooser
  // must be absent.
  await expect(page.getByTestId("first-run-runtime-chooser")).toHaveCount(0);
  const composer = assistantComposer(page);
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await expect(composer).toBeEnabled({ timeout: 30_000 });
}

async function seedAssistantFlowStorage(page: Page): Promise<void> {
  await seedAppStorage(page, {
    "eliza:mobile-runtime-mode": "local",
    // Mark the post-login permission soft-ask as already shown
    // (PERMISSION_PRIMING_STORAGE_KEY in
    // packages/ui/src/components/permissions/permission-priming.ts). On desktop
    // the priming set is non-empty, so PermissionPrimingOverlay otherwise opens
    // a modal "Set up Eliza" dialog over the ready workspace that makes the
    // launcher/wallet buttons inert — this flow exercises views + wallet, not
    // priming (which has its own e2e), so pre-dismiss it like the other
    // onboarding gates seeded here.
    "eliza:permissions-primed": "1",
  });
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
        desktopGetVersion: async () => ({ runtime: "playwright-smoke" }),
        desktopRegisterShortcut: async () => ({ success: true }),
        desktopSetTrayMenu: async () => undefined,
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
    const runtimeWindow = window as unknown as {
      Capacitor?: { Plugins?: Record<string, unknown> };
    };
    if (!runtimeWindow.Capacitor) {
      runtimeWindow.Capacitor = {};
    }
    const capacitor = runtimeWindow.Capacitor;
    if (!capacitor.Plugins) {
      capacitor.Plugins = {};
    }
    const plugins = capacitor.Plugins;
    plugins.TalkMode = {
      addListener: async () => ({ remove: async () => {} }),
      checkPermissions: async () => ({
        microphone: "granted",
        speechRecognition: "not_supported",
      }),
      requestPermissions: async () => ({
        microphone: "granted",
        speechRecognition: "not_supported",
      }),
      start: async () => ({ started: false }),
      stop: async () => {},
      speak: async () => ({
        completed: true,
        interrupted: false,
        usedSystemTts: false,
      }),
      stopSpeaking: async () => ({}),
      isSpeaking: async () => ({ speaking: false }),
    };

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
    (window as unknown as Record<string, unknown>).__homeVoiceSimulate = (
      text: string,
      isFinal: boolean,
    ) => {
      let rec = instances[instances.length - 1];
      for (let index = instances.length - 1; index >= 0; index -= 1) {
        if (instances[index]?.started) {
          rec = instances[index];
          break;
        }
      }
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
        // Force the fresh first-run surface on the initial load; cleared once
        // the test advances to the ready phase below.
        localStorage.setItem("elizaos:first-run:force-fresh", "1");
      }
      localStorage.setItem("eliza:voice:prefix-done", "1");
      localStorage.setItem("eliza:mobile-runtime-mode", "local");
    });
    await page.route("**/api/first-run/status", async (route) => {
      await fulfillJson(route, { complete: false, cloudProvisioned: false });
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#root")).toBeVisible({ timeout: 20_000 });
    await expect(page).not.toHaveURL(/first-run/, { timeout: 12_000 });
    // The fresh first-run choices render inside the real chat transcript; there
    // is no separate full-screen legacy surface.
    const firstRunOverlay = page.getByTestId("chat-overlay");
    await expect(firstRunOverlay).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("first-run-runtime-chooser")).toHaveCount(0);
    await expect(
      page.getByTestId("choice-__first_run__:runtime:cloud"),
    ).toBeVisible({
      timeout: 20_000,
    });
    await screenshot(page, "01-first-run-clouds");

    await page.unroute("**/api/first-run/status");
    await seedAssistantFlowStorage(page);
    // Advance to the ready phase by seeding the "first-run complete" shell state.
    // These are all shell-reserved keys (`eliza:`/`elizaos:`), so the
    // surface-realm raw-global guard (#15247) denies a raw `localStorage` write
    // from the page while the first-run chat surface scope is active — the same
    // rule production shell code satisfies via `shellLocalStorage`. Seed them
    // through `addInitScript` instead: it runs on the next `page.goto`
    // (openReadyChat) before any view mounts and installs the guard, so the
    // writes land in the pre-guard shell context, matching how the other ready-
    // state gates here (seedAssistantFlowStorage / installReadyDesktopStatusBridge)
    // are seeded.
    await page.addInitScript(() => {
      try {
        localStorage.removeItem("elizaos:first-run:force-fresh");
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
      } catch {
        // Sandboxed or opaque-origin frames can deny Web Storage access.
      }
    });
    await installReadyDesktopStatusBridge(page);
    await installAssistantFlowRoutes(page);

    await openReadyChat(page);
    const rootChatInput = assistantComposer(page);
    await expect(page.getByTestId("shell-home-pill")).toHaveCount(0);
    await screenshot(page, "02-assistant-chat-root");

    await rootChatInput.fill("show me my views");
    await screenshot(page, "03-assistant-chat-typing");

    await openAppPath(page, "/chat");
    await expect(assistantComposer(page)).toBeVisible();
    await expect(page.getByTestId("shell-home-pill")).toHaveCount(0);
    await screenshot(page, "04-chat-pill-suppressed");

    await openAppPath(page, "/views");
    const settingsLauncherTile = launcherTile(page, "settings");
    await expect(settingsLauncherTile).toBeVisible({
      timeout: 15_000,
    });
    // The tile's launch control is the inner accessible button (aria-label is
    // the view label) rendered by the launcher IconTile — scope to the tile so
    // this asserts the Settings tile itself, not any other "settings" button.
    await expect(
      settingsLauncherTile.getByRole("button", { name: /Settings/i }),
    ).toBeVisible();
    const automationsLabel = launcherTile(page, "automations").locator(
      "[data-launcher-label]",
    );
    await expect(automationsLabel).toHaveText("Automations");
    expect(
      await automationsLabel.evaluate(
        (label) => label.scrollWidth <= label.clientWidth,
      ),
      "launcher labels must fit their rendered width",
    ).toBe(true);
    await expect(page.getByTestId("shell-home-pill")).toHaveCount(0);
    await screenshot(page, "05-views-with-pill");

    await openAppPath(page, "/wallet");
    await expect(
      page.getByTestId("wallets-sidebar").getByRole("button", {
        name: /^Tokens$/,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "RPC settings", exact: true }),
    ).toBeVisible();
    await screenshot(page, "07-wallet-view-with-pill");
  });

  test("drives the assistant home voice path with a scripted browser STT turn", async ({
    page,
  }) => {
    await seedAssistantFlowStorage(page);
    await installChatSpeechRecognitionShim(page);
    const assistantApi = await installAssistantFlowRoutes(page);

    await openReadyWorkspaceChat(page);

    const mic = assistantMicButton(page);
    await expect(mic).toBeEnabled({ timeout: 30_000 });
    await mic.click();

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

    await expect
      .poll(() => assistantApi.streamRequests, { timeout: 10_000 })
      .toEqual(["show me my pinned views"]);
    await expect
      .poll(
        () =>
          assistantApi.messages
            .filter((message) => message.role === "assistant")
            .map((message) => message.text),
        { timeout: 10_000 },
      )
      .toContain(
        "I heard you. Opening the right view now and keeping voice ready.",
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
    await seedAssistantFlowStorage(page);
    const assistantApi = await installAssistantFlowRoutes(page);

    await openReadyWorkspaceChat(page);

    // The trailing control defaults to the mic; there is no send button until
    // the user types into the composer.
    const initialMic = assistantMicButton(page);
    await expect(initialMic).toBeVisible();
    await expect(initialMic).toBeEnabled({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);

    await assistantComposer(page).fill("open wallet by typing");

    // Typing morphs the single trailing control from mic into send.
    await expect(assistantMicButton(page)).toHaveCount(0);
    const send = page.getByRole("button", { name: "Send" });
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
    await expect(assistantComposer(page)).toHaveValue("");
    await expect(conversationText(page, "open wallet by typing")).toBeVisible();
    await expect(
      page
        .getByText("Opening the right view now and keeping voice ready.")
        .first(),
    ).toBeVisible();
    expect(assistantApi.streamRequests).toEqual(["open wallet by typing"]);
  });

  test("renders the iOS-style home screen and a pinned tile opens its view", async ({
    page,
  }) => {
    await seedAssistantFlowStorage(page);
    await installReadyDesktopStatusBridge(page);
    await installAssistantFlowRoutes(page);

    await openReadyChat(page, "/chat");

    // The home dashboard renders behind the floating chat. The launcher is the
    // second page of the shared Home/Launcher rail.
    await expect(page.getByTestId("home-launcher-surface")).toHaveAttribute(
      "data-page",
      "home",
    );
    await expect(page.getByTestId("home-screen")).toBeVisible();

    const launcher = await navigateHomeLauncher(page, "launcher");
    const settingsTile = launcher.getByTestId("launcher-tile-settings");
    await expect(settingsTile).toBeVisible({ timeout: 15_000 });

    // Tapping the Settings tile navigates to the Settings view (setTab path).
    await settingsTile.getByRole("button").first().click();
    await expect(page.getByTestId("settings-shell")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("a held press on Talk performs the same conversation action as a tap (no dictation arm)", async ({
    page,
  }) => {
    await seedAssistantFlowStorage(page);
    await installChatSpeechRecognitionShim(page);
    const assistantApi = await installAssistantFlowRoutes(page);

    await openReadyWorkspaceChat(page);

    const mic = assistantMicButton(page);
    await expect(mic).toBeEnabled({ timeout: 15_000 });
    // The composer's Talk control no longer arms push-to-talk dictation: a held
    // pointer has exactly the same action as a tap (the Cartesia Talk rework
    // removed the hold machine from the overlay). Hold well past the former
    // 200ms arm threshold and verify no dictation state ever appears.
    await mic.dispatchEvent("pointerdown", {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    await page.waitForTimeout(700);
    await expect(
      page.getByRole("button", { name: /release to insert/i }),
    ).toHaveCount(0);
    await mic.dispatchEvent("pointerup", {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    await mic.click();

    // The release-click starts the same hands-free conversation a tap starts:
    // the scripted final transcript is auto-submitted as a turn, not inserted
    // into the composer draft.
    const accepted = await page.evaluate(() => {
      const simulate = (
        window as unknown as {
          __homeVoiceSimulate?: (text: string, isFinal: boolean) => boolean;
        }
      ).__homeVoiceSimulate;
      return simulate?.("held talk works", true) ?? false;
    });
    expect(accepted, "home voice shim must receive the held turn").toBe(true);

    await expect
      .poll(() => assistantApi.streamRequests, { timeout: 10_000 })
      .toEqual(["held talk works"]);
    const composer = page.locator('[data-testid="chat-composer-textarea"]');
    if ((await composer.count()) > 0) {
      expect((await composer.inputValue()).trim()).toBe("");
    }
  });
});
