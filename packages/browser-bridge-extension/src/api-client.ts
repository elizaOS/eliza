/**
 * BrowserBridgeRelayClient — typed HTTP client for the companion endpoints on
 * the agent API (`/companions/sync`, `/progress`, `/complete`), authenticated
 * with the Bearer pairing token from the companion config. Non-2xx responses
 * are wrapped in RelayApiError carrying the HTTP status and server error code.
 */
import type {
  BrowserBridgeCompanionPreflightResponse,
  BrowserBridgeCompanionSyncResponse,
  BrowserBridgeSettings,
  LifeOpsBrowserSession,
} from "./browser-bridge-contracts";
import type {
  CompanionConfig,
  CompanionPreflightRequest,
  CompanionSessionBeginRequest,
  CompanionSessionCompleteRequest,
  CompanionSessionProgressRequest,
  CompanionSyncRequest,
} from "./protocol";
import { withBrowserBridgeRequestTimeout } from "./request-timeout";

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export class RelayApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "RelayApiError";
  }
}

async function throwApiError(response: Response): Promise<never> {
  let message: string;
  let code: string | null = null;
  try {
    const payload = (await response.json()) as {
      code?: string;
      error?: string;
      message?: string;
    };
    code = typeof payload.code === "string" ? payload.code : null;
    message =
      payload.error ??
      payload.message ??
      `${response.status} ${response.statusText}`;
  } catch {
    // error-policy:J1 The HTTP boundary preserves status even when the remote
    // error body is not valid JSON.
    message = `${response.status} ${response.statusText}`;
  }
  throw new RelayApiError(message, response.status, code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidSyncResponse(message: string): never {
  throw new RelayApiError(
    `Invalid browser companion sync response: ${message}`,
    502,
    "browser_bridge_response_invalid",
  );
}

function readSettings(value: unknown): BrowserBridgeSettings {
  const settings = value;
  if (
    !isRecord(settings) ||
    typeof settings.enabled !== "boolean" ||
    !["off", "current_tab", "active_tabs"].includes(
      String(settings.trackingMode),
    ) ||
    typeof settings.allowBrowserControl !== "boolean" ||
    typeof settings.requireConfirmationForAccountAffecting !== "boolean" ||
    typeof settings.incognitoEnabled !== "boolean" ||
    !["current_site_only", "granted_sites", "all_sites"].includes(
      String(settings.siteAccessMode),
    ) ||
    !Array.isArray(settings.grantedOrigins) ||
    !settings.grantedOrigins.every((entry) => typeof entry === "string") ||
    !Array.isArray(settings.blockedOrigins) ||
    !settings.blockedOrigins.every((entry) => typeof entry === "string") ||
    typeof settings.maxRememberedTabs !== "number" ||
    !Number.isInteger(settings.maxRememberedTabs) ||
    settings.maxRememberedTabs < 1 ||
    (settings.pauseUntil !== null && typeof settings.pauseUntil !== "string") ||
    !isRecord(settings.metadata) ||
    (settings.updatedAt !== null && typeof settings.updatedAt !== "string")
  )
    invalidSyncResponse("settings are malformed");
  return settings as unknown as BrowserBridgeSettings;
}

function readSettingsVersion(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalidSyncResponse("settingsVersion is missing");
  }
  return value;
}

function readCompanion(
  payload: Record<string, unknown>,
  config: CompanionConfig,
): void {
  const companion = payload.companion;
  if (!isRecord(companion)) invalidSyncResponse("companion is missing");
  if (
    companion.id !== config.companionId ||
    companion.browser !== config.browser ||
    companion.profileId !== config.profileId
  ) {
    invalidSyncResponse("companion identity does not match the pairing");
  }
}

function readPreflightResponse(
  payload: unknown,
  config: CompanionConfig,
): BrowserBridgeCompanionPreflightResponse {
  if (!isRecord(payload)) invalidSyncResponse("payload is not an object");
  readCompanion(payload, config);
  for (const forbidden of ["session", "tabs", "currentPage"]) {
    if (Object.hasOwn(payload, forbidden))
      invalidSyncResponse(`preflight contains forbidden ${forbidden} data`);
  }
  return {
    companion:
      payload.companion as BrowserBridgeCompanionPreflightResponse["companion"],
    settings: readSettings(payload.settings),
    settingsVersion: readSettingsVersion(payload.settingsVersion),
  };
}

const ACTION_KINDS = new Set([
  "open",
  "navigate",
  "focus_tab",
  "back",
  "forward",
  "reload",
  "click",
  "type",
  "submit",
  "read_page",
  "extract_links",
  "extract_forms",
]);

function readSession(
  value: unknown,
  config: CompanionConfig,
): LifeOpsBrowserSession | null {
  if (value === null) return null;
  if (!isRecord(value)) invalidSyncResponse("session is malformed");
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.companionId !== config.companionId ||
    value.browser !== config.browser ||
    value.profileId !== config.profileId ||
    !Array.isArray(value.actions) ||
    !Number.isInteger(value.currentActionIndex) ||
    Number(value.currentActionIndex) < 0 ||
    Number(value.currentActionIndex) > value.actions.length
  ) {
    invalidSyncResponse("session identity or checkpoint is invalid");
  }
  for (const action of value.actions) {
    if (
      !isRecord(action) ||
      typeof action.id !== "string" ||
      action.id.length === 0 ||
      typeof action.kind !== "string" ||
      !ACTION_KINDS.has(action.kind) ||
      typeof action.label !== "string" ||
      (action.browser !== null &&
        action.browser !== undefined &&
        action.browser !== config.browser) ||
      (action.windowId !== null &&
        action.windowId !== undefined &&
        typeof action.windowId !== "string") ||
      (action.tabId !== null &&
        action.tabId !== undefined &&
        typeof action.tabId !== "string") ||
      (action.url !== null && typeof action.url !== "string") ||
      (action.selector !== null && typeof action.selector !== "string") ||
      (action.text !== null && typeof action.text !== "string") ||
      typeof action.accountAffecting !== "boolean" ||
      typeof action.requiresConfirmation !== "boolean" ||
      !isRecord(action.metadata)
    ) {
      invalidSyncResponse("session contains a malformed action");
    }
  }
  return value as unknown as LifeOpsBrowserSession;
}

function readSyncResponse(
  payload: unknown,
  config: CompanionConfig,
  requestSettingsVersion: string,
): BrowserBridgeCompanionSyncResponse {
  if (!isRecord(payload)) invalidSyncResponse("payload is not an object");
  readCompanion(payload, config);
  readSettings(payload.settings);
  const settingsVersion = readSettingsVersion(payload.settingsVersion);

  readSession(payload.session, config);
  if (!Array.isArray(payload.tabs)) invalidSyncResponse("tabs are malformed");
  for (const tab of payload.tabs) {
    if (
      !isRecord(tab) ||
      tab.browser !== config.browser ||
      tab.profileId !== config.profileId ||
      tab.companionId !== config.companionId
    ) {
      invalidSyncResponse("tab identity does not match the pairing");
    }
  }
  if (payload.currentPage !== null && !isRecord(payload.currentPage)) {
    invalidSyncResponse("currentPage is malformed");
  }
  if (
    isRecord(payload.currentPage) &&
    (payload.currentPage.browser !== config.browser ||
      payload.currentPage.profileId !== config.profileId ||
      (Object.hasOwn(payload.currentPage, "companionId") &&
        payload.currentPage.companionId !== config.companionId))
  ) {
    invalidSyncResponse("currentPage identity does not match the pairing");
  }
  if (settingsVersion !== requestSettingsVersion)
    invalidSyncResponse("settingsVersion does not match the request");
  return payload as unknown as BrowserBridgeCompanionSyncResponse;
}

export class BrowserBridgeRelayClient {
  constructor(private readonly config: CompanionConfig) {}

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.config.pairingToken}`,
      "Content-Type": "application/json",
      "X-Browser-Bridge-Companion-Id": this.config.companionId,
    };
  }

  async preflight(
    request: CompanionPreflightRequest,
  ): Promise<BrowserBridgeCompanionPreflightResponse> {
    return withBrowserBridgeRequestTimeout(
      "Browser companion preflight",
      async (signal) => {
        const response = await fetch(
          joinUrl(
            this.config.apiBaseUrl,
            "/api/browser-bridge/companions/preflight",
          ),
          {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(request),
            signal,
          },
        );
        if (!response.ok) await throwApiError(response);
        return readPreflightResponse(await response.json(), this.config);
      },
    );
  }

  async sync(
    request: CompanionSyncRequest,
  ): Promise<BrowserBridgeCompanionSyncResponse> {
    return withBrowserBridgeRequestTimeout(
      "Browser companion sync",
      async (signal) => {
        const response = await fetch(
          joinUrl(
            this.config.apiBaseUrl,
            "/api/browser-bridge/companions/sync",
          ),
          {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(request),
            signal,
          },
        );
        if (!response.ok) {
          await throwApiError(response);
        }
        return readSyncResponse(
          await response.json(),
          this.config,
          request.settingsVersion,
        );
      },
    );
  }

  async updateSessionProgress(
    sessionId: string,
    request: CompanionSessionProgressRequest,
  ): Promise<void> {
    await withBrowserBridgeRequestTimeout(
      "Browser session progress",
      async (signal) => {
        const response = await fetch(
          joinUrl(
            this.config.apiBaseUrl,
            `/api/browser-bridge/companions/sessions/${encodeURIComponent(sessionId)}/progress`,
          ),
          {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(request),
            signal,
          },
        );
        if (!response.ok) {
          await throwApiError(response);
        }
      },
    );
  }

  async beginSessionAction(
    sessionId: string,
    request: CompanionSessionBeginRequest,
  ): Promise<LifeOpsBrowserSession> {
    return withBrowserBridgeRequestTimeout(
      "Browser session action begin",
      async (signal) => {
        const response = await fetch(
          joinUrl(
            this.config.apiBaseUrl,
            `/api/browser-bridge/companions/sessions/${encodeURIComponent(sessionId)}/actions/begin`,
          ),
          {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(request),
            signal,
          },
        );
        if (!response.ok) {
          await throwApiError(response);
        }
        const payload = (await response.json()) as unknown;
        if (!isRecord(payload)) invalidSyncResponse("payload is not an object");
        const session = readSession(payload.session, this.config);
        if (!session) invalidSyncResponse("session is missing");
        return session;
      },
    );
  }

  async completeSession(
    sessionId: string,
    request: CompanionSessionCompleteRequest,
  ): Promise<void> {
    await withBrowserBridgeRequestTimeout(
      "Browser session completion",
      async (signal) => {
        const response = await fetch(
          joinUrl(
            this.config.apiBaseUrl,
            `/api/browser-bridge/companions/sessions/${encodeURIComponent(sessionId)}/complete`,
          ),
          {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(request),
            signal,
          },
        );
        if (!response.ok) {
          await throwApiError(response);
        }
      },
    );
  }
}
