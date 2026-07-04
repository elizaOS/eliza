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

const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function isString(value: string | null): value is string {
  return typeof value === "string";
}

function normalizeHostname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    if (!/^https?:\/\//i.test(trimmed)) return null;
    try {
      return normalizeHostname(new URL(trimmed).hostname);
    } catch {
      // error-policy:J3 untrusted hostname input — an unparseable URL is
      // reported as an explicit invalid (null), never a fake-valid default.
      return null;
    }
  }
  const withoutWildcard = trimmed.replace(/^\*\./, "");
  const withoutTrailingDot = withoutWildcard.replace(/\.$/, "");
  const ascii = withoutTrailingDot.toLowerCase();
  return HOSTNAME_RE.test(ascii) ? ascii : null;
}

function validateStartBlockOptions(
  options: StartWebsiteBlockOptions,
): StartWebsiteBlockOptions {
  const candidates = [
    ...(Array.isArray(options?.websites) ? options.websites : []),
    ...(typeof options?.websites === "string" ? [options.websites] : []),
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
    const parsed =
      typeof options.durationMinutes === "number"
        ? options.durationMinutes
        : Number(options.durationMinutes);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error("durationMinutes must be a positive finite number");
    }
    durationMinutes = Math.trunc(parsed);
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
    );
  }

  async stopBlock(): Promise<StopWebsiteBlockResult> {
    return await this.requestJson<StopWebsiteBlockResult>(
      "/api/website-blocker",
      {
        method: "DELETE",
      },
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
