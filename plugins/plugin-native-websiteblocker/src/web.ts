import { WebPlugin } from "@capacitor/core";
import type {
  StartWebsiteBlockOptions,
  StartWebsiteBlockResult,
  StopWebsiteBlockResult,
  WebsiteBlockerOpenSettingsResult,
  WebsiteBlockerPermissionResult,
  WebsiteBlockerStatus,
} from "./definitions";

interface ElizaWindow extends Window {
  /**
   * The renderer's boot-config mirror — the single source of truth for the API
   * base (see packages/ui/src/config/boot-config-store.ts). This web shim reads
   * it rather than a bespoke API-base window global so there is one base value
   * across the app and its native plugins.
   */
  __ELIZAOS_APP_BOOT_CONFIG__?: { apiBase?: string };
  __ELIZA_API_TOKEN__?: string;
}

function readConfiguredApiBase(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const base = (window as ElizaWindow).__ELIZAOS_APP_BOOT_CONFIG__?.apiBase;
  return typeof base === "string" && base.trim().length > 0 ? base : undefined;
}

// The engine's request parser (parseSelfControlBlockRequest in
// @elizaos/plugin-blocker) is the reference for this contract: the API route
// and the WEBSITE_BLOCK action both parse the same options through it, and
// ElizaClient.startWebsiteBlock routes one options object either here or to
// that API. Validation here mirrors the parser so an in-contract block is
// not rejected on web while the identical options start through the API.
const MAX_BLOCK_MINUTES = 7 * 24 * 60;

function isString(value: string | null): value is string {
  return typeof value === "string";
}

function normalizeHostname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value
    .slice(0, 4096)
    .trim()
    .replace(/[),.!?]{1,64}$/g, "");
  if (!trimmed) return null;

  let hostname = trimmed.replace(/^\*\./, "");
  try {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(hostname)
      ? hostname
      : `https://${hostname}`;
    // URL parsing strips any port or path and yields the ASCII (punycode)
    // hostname, so "example.com:8080" and an IDN name resolve to the same
    // host the engine's parser produces.
    hostname = new URL(candidate).hostname;
  } catch {
    // error-policy:J3 untrusted hostname input — keep the raw value so the
    // label checks below reject it as an explicit invalid (null), never a
    // fake-valid default.
  }

  const ascii = hostname.toLowerCase().replace(/\.$/, "");
  if (!ascii || ascii === "localhost" || ascii.endsWith(".local")) {
    return null;
  }
  if (!ascii.includes(".") || ascii.includes(":")) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ascii)) return null;

  const labels = ascii.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith("-") ||
        label.endsWith("-"),
    )
  ) {
    return null;
  }
  // The engine's ASCII conversion yields no host for a numeric top-level
  // label ("example.123"), while a one-letter TLD ("example.c") is valid.
  if (!/^[a-z]+$/.test(labels[labels.length - 1])) return null;

  return ascii;
}

// Mirrors the engine parser's string-list handling: a single string may
// carry a comma/newline-separated list or a bracketed planner-style list
// such as "['twitter.com', 'reddit.com']".
function splitWebsiteString(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(trimmed.replace(/'/g, '"'));
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is string => typeof item === "string",
        );
      }
    } catch {
      // Fall through to the delimiter-based split for malformed planner
      // output, exactly as the engine parser does.
    }
  }
  return trimmed
    .slice(0, 10_000)
    .split(/[,\n]/)
    .map((item) => item.trim().slice(0, 1024))
    .map((item) => item.replace(/^[[\]'"]{1,32}|[[\]'"]{1,32}$/g, ""))
    .filter((item) => item.length > 0);
}

function validateStartBlockOptions(
  options: StartWebsiteBlockOptions,
): StartWebsiteBlockOptions {
  const candidates = [
    ...(Array.isArray(options?.websites) ? options.websites : []),
    ...(typeof options?.websites === "string"
      ? splitWebsiteString(options.websites)
      : []),
  ];
  if (typeof options?.text === "string") {
    candidates.push(...options.text.split(/[\s,]+/));
  }
  const websites = [
    ...new Set(candidates.map(normalizeHostname).filter(isString)),
  ];
  if (websites.length === 0) {
    throw new Error("Provide at least one public website hostname.");
  }

  let durationMinutes: number | null = null;
  if (
    options?.durationMinutes !== undefined &&
    options.durationMinutes !== null
  ) {
    // The engine's request parser (and both native bridges) treat these
    // tokens as a manual block — duration null. Number("manual") is NaN,
    // so without this mapping the web bridge rejected in-contract manual
    // blocks that the same options start successfully through the API.
    const token =
      typeof options.durationMinutes === "string"
        ? options.durationMinutes.trim().toLowerCase()
        : null;
    if (
      token === "indefinite" ||
      token === "manual" ||
      token === "until-unblocked"
    ) {
      return { websites, durationMinutes: null };
    }
    // The engine parser reads a numeric prefix (parseFloat) and rounds to
    // the nearest minute; Number() + truncation rejected in-contract
    // planner strings such as "30abc" and shortened fractional durations.
    const parsed =
      typeof options.durationMinutes === "number"
        ? options.durationMinutes
        : Number.parseFloat(options.durationMinutes);
    if (!Number.isFinite(parsed)) {
      throw new Error("durationMinutes must be a positive finite number");
    }
    durationMinutes = Math.round(parsed);
    if (durationMinutes < 1 || durationMinutes > MAX_BLOCK_MINUTES) {
      throw new Error(
        `durationMinutes must be between 1 and ${MAX_BLOCK_MINUTES} minutes`,
      );
    }
  }

  return { websites, durationMinutes };
}

export class WebsiteBlockerWeb extends WebPlugin {
  private apiBase(): string {
    return readConfiguredApiBase() ?? "";
  }

  private apiToken(): string | null {
    const global =
      typeof window !== "undefined"
        ? (window as ElizaWindow).__ELIZA_API_TOKEN__
        : undefined;
    if (typeof global === "string" && global.trim().length > 0) {
      return global.trim();
    }
    if (typeof window === "undefined") {
      return null;
    }
    const stored = window.sessionStorage.getItem("eliza_api_token");
    return stored?.trim() ? stored.trim() : null;
  }

  private authHeaders(): Record<string, string> {
    const token = this.apiToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private canReachApi(): boolean {
    if (readConfiguredApiBase()) {
      return true;
    }
    if (typeof window === "undefined") {
      return false;
    }
    const protocol = window.location.protocol;
    return protocol === "http:" || protocol === "https:";
  }

  private async requestJson<T>(
    pathname: string,
    init?: RequestInit,
    options?: { resolveFailureBody?: boolean },
  ): Promise<T> {
    if (!this.canReachApi()) {
      throw new Error("Eliza API not available");
    }
    const response = await fetch(`${this.apiBase()}${pathname}`, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...this.authHeaders(),
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      // The start/stop routes answer known failures (a block already
      // running, a stop that needs elevation) with a non-200 status whose
      // JSON body IS the contract's { success: false, error, status? }
      // result — the same variant both native bridges resolve. Throwing a
      // generic error discarded the server's error and status and made
      // that variant unreachable on web, so resolve the body when it
      // carries the failure shape and throw only otherwise.
      if (options?.resolveFailureBody) {
        const body: unknown = await response.json().catch(() => null);
        if (
          typeof body === "object" &&
          body !== null &&
          (body as { success?: unknown }).success === false &&
          typeof (body as { error?: unknown }).error === "string"
        ) {
          return body as T;
        }
      }
      throw new Error(`Request failed (${response.status})`);
    }
    return (await response.json()) as T;
  }

  async getStatus(): Promise<WebsiteBlockerStatus> {
    return await this.requestJson<WebsiteBlockerStatus>("/api/website-blocker");
  }

  async startBlock(
    options: StartWebsiteBlockOptions,
  ): Promise<StartWebsiteBlockResult> {
    const body = validateStartBlockOptions(options);
    return await this.requestJson<StartWebsiteBlockResult>(
      "/api/website-blocker",
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
      { resolveFailureBody: true },
    );
  }

  async stopBlock(): Promise<StopWebsiteBlockResult> {
    return await this.requestJson<StopWebsiteBlockResult>(
      "/api/website-blocker",
      {
        method: "DELETE",
      },
      { resolveFailureBody: true },
    );
  }

  async checkPermissions(): Promise<WebsiteBlockerPermissionResult> {
    const permission = await this.requestJson<{
      status: WebsiteBlockerPermissionResult["status"];
      canRequest: boolean;
      canOpenSettings?: boolean;
      settingsTarget?: WebsiteBlockerPermissionResult["settingsTarget"];
      engine?: WebsiteBlockerPermissionResult["engine"];
      reason?: string;
    }>("/api/permissions/website-blocking");
    return {
      status: permission.status,
      canRequest: permission.canRequest,
      canOpenSettings: permission.canOpenSettings ?? true,
      settingsTarget: permission.settingsTarget ?? "runtime",
      engine: permission.engine ?? "hosts-file",
      reason: permission.reason,
    };
  }

  async requestPermissions(): Promise<WebsiteBlockerPermissionResult> {
    const permission = await this.requestJson<{
      status: WebsiteBlockerPermissionResult["status"];
      canRequest: boolean;
      canOpenSettings?: boolean;
      settingsTarget?: WebsiteBlockerPermissionResult["settingsTarget"];
      engine?: WebsiteBlockerPermissionResult["engine"];
      reason?: string;
    }>("/api/permissions/website-blocking/request", {
      method: "POST",
    });
    return {
      status: permission.status,
      canRequest: permission.canRequest,
      canOpenSettings: permission.canOpenSettings ?? true,
      settingsTarget: permission.settingsTarget ?? "runtime",
      engine: permission.engine ?? "hosts-file",
      reason: permission.reason,
    };
  }

  async openSettings(): Promise<WebsiteBlockerOpenSettingsResult> {
    if (!this.canReachApi()) {
      return {
        opened: false,
        target: "runtime",
        actualTarget: "runtime",
        reason: "Eliza API not available.",
      };
    }
    const result = await this.requestJson<
      Partial<WebsiteBlockerOpenSettingsResult>
    >("/api/permissions/website-blocking/open-settings", {
      method: "POST",
    });
    return {
      opened: result.opened ?? false,
      target: result.target ?? "runtime",
      actualTarget: result.actualTarget ?? result.target ?? "runtime",
      reason: result.reason ?? null,
    };
  }
}
