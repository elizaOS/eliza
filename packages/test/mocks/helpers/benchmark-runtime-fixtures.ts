import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Capacitor } from "@capacitor/core";
import type { AgentRuntime } from "@elizaos/core";
import { FakeSubscriptionComputerUseService } from "../../helpers/subscription-computer-use-fixture.ts";

const MOCK_SCREENSHOT_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+R4QAAAAASUVORK5CYII=";

type Cleanup = () => Promise<void> | void;

export interface BenchmarkRuntimeFixturesEnvironment {
  envVars: Record<string, string>;
  applyRuntimeFixtures(runtime: AgentRuntime): Promise<Cleanup>;
  cleanup(): Promise<void>;
}

function buildMockBrowserContent(pathname: string): string {
  const normalized = pathname.toLowerCase();
  if (normalized.includes("login-required")) {
    return "Sign in to continue";
  }
  if (normalized.includes("phone-only")) {
    return "Call us to cancel";
  }
  if (normalized.includes("google-play") || normalized.includes("apple")) {
    return "Subscriptions Cancel subscription";
  }
  return "Subscriptions Cancel subscription";
}

async function startFixtureServer(): Promise<{
  baseUrl: string;
  stop(): Promise<void>;
}> {
  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    if (
      method === "POST" &&
      requestUrl.pathname === "/api/v1/device-bus/intents"
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const payloadText = Buffer.concat(chunks).toString("utf8");
      const payload =
        payloadText.length > 0
          ? (JSON.parse(payloadText) as Record<string, unknown>)
          : {};
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          intentId: crypto.randomUUID(),
          deliveredTo: ["desktop", "mobile"],
          kind: payload.kind ?? null,
        }),
      );
      return;
    }

    if (method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<html><body>${buildMockBrowserContent(requestUrl.pathname)}</body></html>`,
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind mocked fixture server");
  }
  const port = (address as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function installAppBlockerFixture(): Cleanup {
  const capacitor = Capacitor as {
    Plugins?: Record<string, unknown>;
  };
  const previousPlugins = capacitor.Plugins;
  const plugins = { ...(previousPlugins ?? {}) };
  let blockedPackageNames: string[] = [];
  let endsAt: string | null = null;

  const installedApps = [
    {
      packageName: "com.tinyspeck.slackmacgap",
      displayName: "Slack",
    },
    {
      packageName: "com.supercell.clashofclans",
      displayName: "Clash of Clans",
    },
    {
      packageName: "com.roblox.client",
      displayName: "Roblox",
    },
    {
      packageName: "com.mojang.minecraftpe",
      displayName: "Minecraft",
    },
  ];

  const plugin = {
    async checkPermissions() {
      return { status: "granted", canRequest: false };
    },
    async requestPermissions() {
      return { status: "granted", canRequest: false };
    },
    async getInstalledApps() {
      return { apps: installedApps };
    },
    async selectApps() {
      return { apps: installedApps, cancelled: false };
    },
    async blockApps(options: {
      packageNames?: string[];
      appTokens?: string[];
      durationMinutes?: number | null;
    }) {
      blockedPackageNames = [
        ...(options.packageNames ?? []),
        ...(options.appTokens ?? []),
      ];
      endsAt =
        typeof options.durationMinutes === "number"
          ? new Date(
              Date.now() + options.durationMinutes * 60_000,
            ).toISOString()
          : null;
      return {
        success: true,
        blockedCount: blockedPackageNames.length,
        endsAt,
      };
    },
    async unblockApps() {
      blockedPackageNames = [];
      endsAt = null;
      return { success: true };
    },
    async getStatus() {
      return {
        available: true,
        active: blockedPackageNames.length > 0,
        platform: "android",
        engine: "usage-stats-overlay",
        blockedCount: blockedPackageNames.length,
        blockedPackageNames,
        endsAt,
        permissionStatus: "granted",
      };
    },
  };

  plugins.ElizaAppBlocker = plugin;
  plugins.AppBlocker = plugin;
  capacitor.Plugins = plugins;

  return () => {
    capacitor.Plugins = previousPlugins;
  };
}

function createBenchmarkComputerUseService() {
  const browser = new FakeSubscriptionComputerUseService("fixture_streaming");

  return {
    getCapabilities() {
      return {
        screenshot: { available: true, tool: "fixture-screenshot" },
        computerUse: { available: true, tool: "fixture-desktop" },
        windowList: { available: true, tool: "fixture-window-list" },
        browser: { available: true, tool: "fixture-browser" },
        terminal: { available: true, tool: "fixture-terminal" },
        fileSystem: { available: true, tool: "fixture-file-system" },
      };
    },
    async executeDesktopAction(params: { action?: string; text?: string }) {
      return {
        success: true,
        screenshot: MOCK_SCREENSHOT_BASE64,
        message:
          params.action === "screenshot"
            ? "Mocked desktop screenshot captured."
            : `Mocked desktop action completed: ${params.action ?? "desktop"}.`,
        content:
          params.text && params.text.trim().length > 0
            ? params.text
            : "Mocked desktop action completed.",
      };
    },
    async executeBrowserAction(params: Record<string, unknown>) {
      return browser.executeBrowserAction(params as never);
    },
    async executeWindowAction(params: { action?: string }) {
      return {
        success: true,
        message: `Mocked window action completed: ${params.action ?? "window"}.`,
      };
    },
    async executeFileAction(params: { action?: string; path?: string }) {
      return {
        success: true,
        message: `Mocked file action completed: ${params.action ?? "file"}.`,
        path: params.path ?? null,
      };
    },
    async executeTerminalAction(params: { action?: string; command?: string }) {
      return {
        success: true,
        message: `Mocked terminal action completed: ${params.action ?? "terminal"}.`,
        output: params.command ?? "",
      };
    },
  };
}

function registerBenchmarkSendHandlers(runtime: AgentRuntime): void {
  const channels = ["telegram", "discord", "signal"] as const;
  for (const channel of channels) {
    runtime.registerSendHandler(channel, async () => {});
  }
}

export async function createBenchmarkRuntimeFixturesEnvironment(): Promise<BenchmarkRuntimeFixturesEnvironment> {
  const fixtureServer = await startFixtureServer();
  const restoreAppBlocker = installAppBlockerFixture();

  return {
    envVars: {
      ELIZA_TEST_PASSWORD_MANAGER_BACKEND: "fixture",
      ELIZA_TEST_COMPUTERUSE_BACKEND: "fixture",
      ELIZA_TEST_REMOTE_DESKTOP_BACKEND: "fixture",
      ELIZA_REMOTE_LOCAL_MODE: "1",
      ELIZA_DEVICE_BUS_URL: fixtureServer.baseUrl,
      ELIZA_DEVICE_BUS_TOKEN: "mock-device-bus-token",
      ELIZA_SUBSCRIPTION_FIXTURE_BASE_URL: fixtureServer.baseUrl,
      ELIZA_E2E_TWILIO_RECIPIENT: "+15555550199",
      TWILIO_CALL_EXTERNAL_ALLOWLIST: "+15555550110 +15555550111 +15555550199",
    },
    async applyRuntimeFixtures(runtime) {
      registerBenchmarkSendHandlers(runtime);

      const benchmarkComputerUseService = createBenchmarkComputerUseService();
      const originalGetService = runtime.getService.bind(runtime);
      runtime.getService = ((serviceType: string) => {
        if (serviceType === "computeruse") {
          return benchmarkComputerUseService;
        }
        return originalGetService(serviceType);
      }) as typeof runtime.getService;

      return async () => {
        runtime.getService = originalGetService as typeof runtime.getService;
      };
    },
    async cleanup() {
      restoreAppBlocker();
      await fixtureServer.stop();
    },
  };
}
