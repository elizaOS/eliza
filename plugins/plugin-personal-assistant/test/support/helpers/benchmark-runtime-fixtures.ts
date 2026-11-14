/** Provides benchmark runtime fixtures helper utilities shared by package tests and scenario harnesses. */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Capacitor } from "@capacitor/core";
import type { AgentRuntime } from "@elizaos/core";
import { clearPasswordManagerBackendCache } from "@elizaos/plugin-browser/password-manager-bridge";
import { FakeSubscriptionComputerUseService } from "./subscription-computer-use-fixture.ts";

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

const PASSWORD_MANAGER_ITEMS = [
  {
    id: "pm-github",
    title: "GitHub",
    category: "LOGIN",
    additional_information: "benchmark-user",
    urls: [{ href: "https://github.com/login", primary: true }],
    tags: ["dev", "github", "code"],
    vault: { name: "Mocked Benchmark" },
  },
  {
    id: "pm-google-workspace",
    title: "Google Workspace",
    category: "LOGIN",
    additional_information: "owner@example.com",
    urls: [{ href: "https://mail.google.com", primary: true }],
    tags: ["google", "email"],
    vault: { name: "Mocked Benchmark" },
  },
  {
    id: "pm-aws-prod",
    title: "AWS Console",
    category: "LOGIN",
    additional_information: "infra@example.com",
    urls: [{ href: "https://signin.aws.amazon.com", primary: true }],
    tags: ["aws", "cloud"],
    vault: { name: "Mocked Benchmark" },
  },
];

/**
 * Puts a fake 1Password CLI and file-backed clipboard tools first on PATH, so
 * the password-manager action runs its real 1Password path without touching
 * a real vault or the host clipboard.
 */
function installPasswordManagerFixture(): {
  binDir: string;
  clipboardFile: string;
  cleanup: Cleanup;
} {
  const binDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "benchmark-password-manager-"),
  );
  const clipboardFile = path.join(binDir, "clipboard");
  fs.writeFileSync(clipboardFile, "");
  const op = `#!${process.execPath}
const args = process.argv.slice(2);
const item = args.indexOf("item");
if (args.includes("--version")) process.stdout.write("2.30.0\\n");
else if (args[item + 1] === "list") process.stdout.write(${JSON.stringify(JSON.stringify(PASSWORD_MANAGER_ITEMS))});
else if (args[item + 1] === "get") process.stdout.write(args.includes("password") ? "benchmark-password\\n" : "benchmark-user\\n");
else process.exit(1);
`;
  const clipboard = `#!${process.execPath}
const fs = require("node:fs");
const file = process.env.BENCHMARK_CLIPBOARD_FILE;
const read = process.argv[1].endsWith("pbpaste") || process.argv[1].endsWith("wl-paste") || process.argv.includes("-out");
if (read) process.stdout.write(fs.readFileSync(file));
else { const chunks = []; process.stdin.on("data", (chunk) => chunks.push(chunk)); process.stdin.on("end", () => fs.writeFileSync(file, Buffer.concat(chunks))); }
`;
  fs.writeFileSync(path.join(binDir, "op"), op, { mode: 0o700 });
  for (const name of ["pbcopy", "pbpaste", "xclip", "wl-copy", "wl-paste"]) {
    fs.writeFileSync(path.join(binDir, name), clipboard, { mode: 0o700 });
  }
  clearPasswordManagerBackendCache();
  return {
    binDir,
    clipboardFile,
    cleanup: () => {
      clearPasswordManagerBackendCache();
      fs.rmSync(binDir, { recursive: true, force: true });
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
        clipboard: { available: true, tool: "fixture-clipboard" },
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
    // Read-only computer state the computer-state / scene providers and the
    // COMPUTER_USE progress + CLIPBOARD paths consult through
    // getService("computeruse"); the real ComputerUseService exposes these, so
    // a stub omitting any of them throws mid-turn (getScreenDimensions /
    // getCurrentScene / getApprovalSnapshot "is not a function").
    getScreenDimensions() {
      return { width: 2560, height: 1600 };
    },
    getDisplays() {
      return [] as Array<{ id: number; name: string }>;
    },
    getApprovalSnapshot() {
      return {
        mode: "full_control",
        pendingCount: 0,
        pendingApprovals: [] as Array<{ id: string; command?: string }>,
      };
    },
    // The COMPUTER_USE progress relay subscribes to approval changes; a stub
    // returning no unsubscribe (or omitting this) throws before the action runs.
    subscribeApprovals(_listener: (snapshot: unknown) => void): () => void {
      return () => undefined;
    },
    getRecentActions() {
      return [] as Array<{ action: string; success: boolean }>;
    },
    getCurrentScene() {
      return null;
    },
    async refreshScene() {
      return null;
    },
  };
}

function registerBenchmarkSendHandlers(runtime: AgentRuntime): void {
  const channels = ["telegram", "discord", "whatsapp"] as const;
  for (const channel of channels) {
    runtime.registerSendHandler(channel, async () => {});
  }
}

export async function createBenchmarkRuntimeFixturesEnvironment(): Promise<BenchmarkRuntimeFixturesEnvironment> {
  const fixtureServer = await startFixtureServer();
  const restoreAppBlocker = installAppBlockerFixture();
  const passwordManager = installPasswordManagerFixture();

  return {
    envVars: {
      PATH: `${passwordManager.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      BENCHMARK_CLIPBOARD_FILE: passwordManager.clipboardFile,
      ELIZA_TEST_COMPUTERUSE_BACKEND: "fixture",
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
      passwordManager.cleanup();
      await fixtureServer.stop();
    },
  };
}
