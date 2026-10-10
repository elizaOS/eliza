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

// Single engine-parity label grammar for every bare hostname, replacing the
// ASCII-only HOSTNAME_RE:
// plugins/plugin-blocker/src/services/website-blocker/engine.ts validates
// each label against [a-z0-9-] with hyphen edges rejected — including the TLD,
// so punycode TLDs such as xn--p1ai (пример.рф) pass on the server while a
// letters-only TLD rule rejects them here. The TLD must still carry at least
// one letter: the engine rejects IP literals (node:net isIP), and an
// all-numeric dotted quad is the only punycode-reachable shape the engine
// refuses — verified that node's domainToASCII itself returns "" for
// all-numeric TLDs (e.g. café.123), so the letter test keeps web at parity
// without a node:net import in browser code. One path, one grammar: every
// bare hostname below punycode-encodes through the WHATWG URL parser (IDNA
// ToASCII — the same primitive the engine's domainToASCII uses), so the ASCII
// and unicode spellings of an IDN name ("xn--e1afmkfd.xn--p1ai" and "пример.рф")
// validate identically.
const ENGINE_PARITY_HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?=[a-z0-9-]*[a-z])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isString(value: string | null): value is string {
  return typeof value === "string";
}

/**
 * Normalizes one bare hostname candidate to its engine-canonical ASCII form
 * (IDNA ToASCII), or null when the input is not a valid public hostname.
 * Exported for the unit test (src/web.test.ts); not re-exported from the
 * package entry point.
 */
export function normalizeHostname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // The engine's scheme check requires "://" (engine.ts normalizeWebsiteTarget),
  // so "example.com:8080" is a bare hostname with a port — not a URL — and
  // punycode-encodes through the shared path below exactly like the engine.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
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
  // One path for every bare hostname: the URL parser punycode-encodes
  // .hostname (IDNA ToASCII — the same primitive the engine's domainToASCII
  // uses) and the single engine-parity grammar above validates the result.
  // This strips ports and userinfo exactly like the engine's
  // `new URL(...).hostname` normalization (engine.ts normalizeWebsiteTarget),
  // so "example.com:8080" and "user@example.com" normalize to "example.com"
  // on both sides — previously the ASCII path rejected them outright.
  try {
    const encoded = new URL(`https://${withoutTrailingDot}`).hostname;
    return ENGINE_PARITY_HOSTNAME_RE.test(encoded) ? encoded : null;
  } catch {
    // error-policy:J3 untrusted hostname input — an unparseable hostname is
    // reported as an explicit invalid (null), never a fake-valid default.
    return null;
  }
}

/**
 * Validates startBlock options: collects hostname candidates from `websites`
 * and `text`, normalizes each through normalizeHostname, and drops invalid
 * entries. Throws when nothing valid remains. Exported for the unit test
 * (src/web.test.ts); not re-exported from the package entry point.
 */
export function validateStartBlockOptions(
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
    const parsed =
      typeof options.durationMinutes === "number"
        ? options.durationMinutes
        : Number(options.durationMinutes);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error("durationMinutes must be a positive finite number");
    }
    durationMinutes = Math.trunc(parsed);
    if (durationMinutes < 1) {
      throw new Error("durationMinutes must be at least 1 minute");
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
