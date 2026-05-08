import type { LifeOpsBrowserCompanionSyncResponse } from "@elizaos/shared/contracts/lifeops";
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

async function throwApiError(response: Response): never {
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
  ): Promise<LifeOpsBrowserCompanionSyncResponse> {
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
    return (await response.json()) as LifeOpsBrowserCompanionSyncResponse;
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
