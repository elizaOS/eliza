/**
 * BrowserBridgeRelayClient — typed HTTP client for the companion endpoints on
 * the agent API (`/companions/sync`, `/progress`, `/complete`), authenticated
 * with the Bearer pairing token from the companion config. Non-2xx responses
 * are wrapped in RelayApiError carrying the HTTP status and server error code.
 */
import type { BrowserBridgeCompanionSyncResponse } from "./browser-bridge-contracts";
import type {
  CompanionConfig,
  CompanionSessionCompleteRequest,
  CompanionSessionProgressRequest,
  CompanionSyncRequest,
} from "./protocol";

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

function readSyncResponse(
  payload: unknown,
  config: CompanionConfig,
): BrowserBridgeCompanionSyncResponse {
  if (!isRecord(payload)) invalidSyncResponse("payload is not an object");
  const companion = payload.companion;
  if (!isRecord(companion)) invalidSyncResponse("companion is missing");
  if (
    companion.id !== config.companionId ||
    companion.browser !== config.browser ||
    companion.profileId !== config.profileId
  ) {
    invalidSyncResponse("companion identity does not match the pairing");
  }

  const settings = payload.settings;
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
    !settings.grantedOrigins.every((value) => typeof value === "string") ||
    !Array.isArray(settings.blockedOrigins) ||
    !settings.blockedOrigins.every((value) => typeof value === "string") ||
    typeof settings.maxRememberedTabs !== "number" ||
    !Number.isInteger(settings.maxRememberedTabs) ||
    settings.maxRememberedTabs < 1 ||
    (settings.pauseUntil !== null && typeof settings.pauseUntil !== "string") ||
    !isRecord(settings.metadata) ||
    (settings.updatedAt !== null && typeof settings.updatedAt !== "string")
  ) {
    invalidSyncResponse("settings are malformed");
  }

  const session = payload.session;
  if (session !== null) {
    if (!isRecord(session)) invalidSyncResponse("session is malformed");
    if (
      typeof session.id !== "string" ||
      session.id.length === 0 ||
      (session.companionId !== null &&
        session.companionId !== config.companionId) ||
      (session.browser !== null && session.browser !== config.browser) ||
      (session.profileId !== null && session.profileId !== config.profileId) ||
      !Array.isArray(session.actions) ||
      !Number.isInteger(session.currentActionIndex) ||
      Number(session.currentActionIndex) < 0 ||
      Number(session.currentActionIndex) > session.actions.length
    ) {
      invalidSyncResponse("session identity or checkpoint is invalid");
    }
    for (const action of session.actions) {
      if (
        !isRecord(action) ||
        typeof action.id !== "string" ||
        action.id.length === 0 ||
        typeof action.kind !== "string" ||
        !ACTION_KINDS.has(action.kind) ||
        (action.url !== null && typeof action.url !== "string") ||
        (action.selector !== null && typeof action.selector !== "string") ||
        (action.text !== null && typeof action.text !== "string")
      ) {
        invalidSyncResponse("session contains a malformed action");
      }
    }
  }
  if (!Array.isArray(payload.tabs)) invalidSyncResponse("tabs are malformed");
  if (payload.currentPage !== null && !isRecord(payload.currentPage)) {
    invalidSyncResponse("currentPage is malformed");
  }
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

  async sync(
    request: CompanionSyncRequest,
  ): Promise<BrowserBridgeCompanionSyncResponse> {
    const response = await fetch(
      joinUrl(this.config.apiBaseUrl, "/api/browser-bridge/companions/sync"),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(request),
      },
    );
    if (!response.ok) {
      await throwApiError(response);
    }
    return readSyncResponse(await response.json(), this.config);
  }

  async updateSessionProgress(
    sessionId: string,
    request: CompanionSessionProgressRequest,
  ): Promise<void> {
    const response = await fetch(
      joinUrl(
        this.config.apiBaseUrl,
        `/api/browser-bridge/companions/sessions/${encodeURIComponent(sessionId)}/progress`,
      ),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(request),
      },
    );
    if (!response.ok) {
      await throwApiError(response);
    }
  }

  async completeSession(
    sessionId: string,
    request: CompanionSessionCompleteRequest,
  ): Promise<void> {
    const response = await fetch(
      joinUrl(
        this.config.apiBaseUrl,
        `/api/browser-bridge/companions/sessions/${encodeURIComponent(sessionId)}/complete`,
      ),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(request),
      },
    );
    if (!response.ok) {
      await throwApiError(response);
    }
  }
}
