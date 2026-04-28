import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildDiscordProbeScript,
  type DiscordDmInboxProbe,
  type DiscordTabProbe,
  type DiscordVisibleDmPreview,
} from "./discord-browser-scraper.js";

const DEFAULT_DISCORD_DESKTOP_CDP_PORT = 9224;
const DISCORD_DESKTOP_CDP_HOST = "127.0.0.1";
const DISCORD_DESKTOP_QUIT_TIMEOUT_MS = 10_000;
const DISCORD_DESKTOP_READY_TIMEOUT_MS = 20_000;
const DISCORD_DESKTOP_POLL_INTERVAL_MS = 500;
const DISCORD_DESKTOP_FETCH_TIMEOUT_MS = 900;
const DISCORD_DESKTOP_EVALUATE_TIMEOUT_MS = 2_500;

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface CdpVersionResponse {
  Browser?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string | null;
}

interface CdpRpcResponse {
  id?: number;
  error?: {
    message?: string;
  };
  result?: {
    result?: {
      value?: unknown;
      description?: string;
    };
  };
}

export interface DiscordDesktopCdpStatus {
  supported: boolean;
  platform: NodeJS.Platform;
  port: number;
  appRunning: boolean;
  cdpAvailable: boolean;
  browserVersion: string | null;
  targetUrl: string | null;
  targetTitle: string | null;
  webSocketDebuggerUrl: string | null;
  probe: DiscordTabProbe | null;
  lastError: string | null;
}

function configuredDiscordDesktopCdpPort(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.MILADY_DISCORD_DESKTOP_CDP_PORT?.trim();
  if (!raw) {
    return DEFAULT_DISCORD_DESKTOP_CDP_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65_536
    ? parsed
    : DEFAULT_DISCORD_DESKTOP_CDP_PORT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function execFileAsync(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

async function discordAppRunning(): Promise<boolean> {
  try {
    await execFileAsync("/usr/bin/pgrep", ["-x", "Discord"], 1_000);
    return true;
  } catch {
    return false;
  }
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function normalizeCdpTarget(value: unknown): CdpTarget | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" ? value.id : "";
  const type = typeof value.type === "string" ? value.type : "";
  const title = typeof value.title === "string" ? value.title : "";
  const url = typeof value.url === "string" ? value.url : "";
  const webSocketDebuggerUrl =
    typeof value.webSocketDebuggerUrl === "string"
      ? value.webSocketDebuggerUrl
      : null;
  if (!id || !type) {
    return null;
  }
  return { id, type, title, url, webSocketDebuggerUrl };
}

function pickDiscordTarget(targets: CdpTarget[]): CdpTarget | null {
  const pageTargets = targets.filter(
    (target) => target.type === "page" && target.webSocketDebuggerUrl,
  );
  return (
    pageTargets.find(
      (target) =>
        target.url.includes("discord.com") || /discord/i.test(target.title),
    ) ??
    pageTargets[0] ??
    null
  );
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeDmPreview(value: unknown): DiscordVisibleDmPreview | null {
  if (!isRecord(value)) {
    return null;
  }
  const label = normalizeString(value.label);
  if (!label) {
    return null;
  }
  return {
    channelId: normalizeString(value.channelId),
    href: normalizeString(value.href),
    label,
    selected: value.selected === true,
    unread: value.unread === true,
    snippet: normalizeString(value.snippet),
  };
}

function normalizeDmInbox(value: unknown): DiscordDmInboxProbe {
  const record = isRecord(value) ? value : {};
  const previews = Array.isArray(record.previews)
    ? record.previews
        .map((preview) => normalizeDmPreview(preview))
        .filter(
          (preview): preview is DiscordVisibleDmPreview => preview !== null,
        )
    : [];
  return {
    visible: record.visible === true,
    count: typeof record.count === "number" ? record.count : previews.length,
    selectedChannelId: normalizeString(record.selectedChannelId),
    previews,
  };
}

function normalizeDiscordProbe(value: unknown): DiscordTabProbe | null {
  if (!isRecord(value)) {
    return null;
  }
  const identity = isRecord(value.identity) ? value.identity : {};
  return {
    loggedIn: value.loggedIn === true,
    url: normalizeString(value.url),
    identity: {
      id: normalizeString(identity.id),
      username: normalizeString(identity.username),
      discriminator: normalizeString(identity.discriminator),
    },
    rawSnippet: normalizeString(value.rawSnippet),
    dmInbox: normalizeDmInbox(value.dmInbox),
  };
}

async function evaluateDiscordProbe(
  webSocketDebuggerUrl: string,
): Promise<DiscordTabProbe> {
  const WebSocketConstructor = globalThis.WebSocket;
  if (!WebSocketConstructor) {
    throw new Error("WebSocket is not available in this runtime");
  }

  return new Promise((resolve, reject) => {
    const requestId = 1;
    const socket = new WebSocketConstructor(webSocketDebuggerUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out while probing Discord desktop"));
    }, DISCORD_DESKTOP_EVALUATE_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.close();
    };
    const failProbe = (error: Error) => {
      cleanup();
      reject(error);
    };
    const resolveProbe = (probe: DiscordTabProbe) => {
      cleanup();
      resolve(probe);
    };

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: requestId,
          method: "Runtime.evaluate",
          params: {
            expression: buildDiscordProbeScript(),
            awaitPromise: true,
            returnByValue: true,
          },
        }),
      );
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      let payload: CdpRpcResponse;
      try {
        payload = JSON.parse(String(event.data)) as CdpRpcResponse;
      } catch {
        return;
      }
      if (payload.id !== requestId) {
        return;
      }
      if (payload.error) {
        failProbe(
          new Error(payload.error.message ?? "Discord desktop probe failed"),
        );
        return;
      }
      const probe = normalizeDiscordProbe(payload.result?.result?.value);
      if (!probe) {
        failProbe(
          new Error(
            payload.result?.result?.description ??
              "Discord desktop returned an invalid probe",
          ),
        );
        return;
      }
      resolveProbe(probe);
    });

    socket.addEventListener("error", () => {
      failProbe(new Error("Discord desktop CDP websocket failed"));
    });
  });
}

export async function getDiscordDesktopCdpStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DiscordDesktopCdpStatus> {
  const platform = process.platform;
  const port = configuredDiscordDesktopCdpPort(env);
  const appRunning = platform === "darwin" ? await discordAppRunning() : false;
  if (platform !== "darwin") {
    return {
      supported: false,
      platform,
      port,
      appRunning,
      cdpAvailable: false,
      browserVersion: null,
      targetUrl: null,
      targetTitle: null,
      webSocketDebuggerUrl: null,
      probe: null,
      lastError: "Discord Desktop control is currently supported on macOS.",
    };
  }

  const baseUrl = `http://${DISCORD_DESKTOP_CDP_HOST}:${port}`;
  try {
    const [version, rawTargets] = await Promise.all([
      fetchJson<CdpVersionResponse>(
        `${baseUrl}/json/version`,
        DISCORD_DESKTOP_FETCH_TIMEOUT_MS,
      ),
      fetchJson<unknown[]>(
        `${baseUrl}/json/list`,
        DISCORD_DESKTOP_FETCH_TIMEOUT_MS,
      ).catch(() => []),
    ]);
    const targets = rawTargets
      .map((target) => normalizeCdpTarget(target))
      .filter((target): target is CdpTarget => target !== null);
    const target = pickDiscordTarget(targets);
    let probe: DiscordTabProbe | null = null;
    let lastError: string | null = null;
    if (target?.webSocketDebuggerUrl) {
      try {
        probe = await evaluateDiscordProbe(target.webSocketDebuggerUrl);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      supported: true,
      platform,
      port,
      appRunning,
      cdpAvailable: true,
      browserVersion: version.Browser ?? null,
      targetUrl: target?.url ?? null,
      targetTitle: target?.title ?? null,
      webSocketDebuggerUrl:
        target?.webSocketDebuggerUrl ?? version.webSocketDebuggerUrl ?? null,
      probe,
      lastError,
    };
  } catch (error) {
    return {
      supported: true,
      platform,
      port,
      appRunning,
      cdpAvailable: false,
      browserVersion: null,
      targetUrl: null,
      targetTitle: null,
      webSocketDebuggerUrl: null,
      probe: null,
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function waitForDiscordToQuit(): Promise<void> {
  const deadline = Date.now() + DISCORD_DESKTOP_QUIT_TIMEOUT_MS;
  while (await discordAppRunning()) {
    if (Date.now() >= deadline) {
      throw new Error("Discord did not quit before the relaunch timeout.");
    }
    await delay(250);
  }
}

async function waitForDiscordCdpReady(
  env: NodeJS.ProcessEnv,
): Promise<DiscordDesktopCdpStatus> {
  const deadline = Date.now() + DISCORD_DESKTOP_READY_TIMEOUT_MS;
  let latest = await getDiscordDesktopCdpStatus(env);
  while (!latest.cdpAvailable) {
    if (Date.now() >= deadline) {
      throw new Error(
        latest.lastError ??
          "Discord did not expose a desktop control endpoint before the timeout.",
      );
    }
    await delay(DISCORD_DESKTOP_POLL_INTERVAL_MS);
    latest = await getDiscordDesktopCdpStatus(env);
  }
  return latest;
}

export async function relaunchDiscordDesktopForCdp(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DiscordDesktopCdpStatus> {
  const current = await getDiscordDesktopCdpStatus(env);
  if (!current.supported) {
    throw new Error(
      current.lastError ?? "Discord Desktop control unavailable.",
    );
  }
  if (current.cdpAvailable) {
    return current;
  }

  if (current.appRunning) {
    await execFileAsync(
      "/usr/bin/osascript",
      ["-e", 'quit app "Discord"'],
      5_000,
    );
    await waitForDiscordToQuit();
  }

  const port = configuredDiscordDesktopCdpPort(env);
  await execFileAsync(
    "/usr/bin/open",
    [
      "-a",
      "Discord",
      "--args",
      `--remote-debugging-port=${port}`,
      `--remote-debugging-address=${DISCORD_DESKTOP_CDP_HOST}`,
      "--remote-allow-origins=*",
    ],
    5_000,
  );

  return waitForDiscordCdpReady(env);
}
