import type { LifeOpsBrowserCompanionSyncResponse } from "@elizaos/app-lifeops/contracts";
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
  ) {
    super(message);
    this.name = "RelayApiError";
  }
}

async function throwApiError(response: Response): never {
  let message: string;
  try {
    const payload = (await response.json()) as {
      error?: string;
      message?: string;
    };
    message =
      payload.error ??
      payload.message ??
      `${response.status} ${response.statusText}`;
  } catch {
    message = `${response.status} ${response.statusText}`;
  }
  throw new RelayApiError(message, response.status);
}

export class LifeOpsBrowserRelayClient {
  constructor(private readonly config: CompanionConfig) {}

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.config.pairingToken}`,
      "Content-Type": "application/json",
      "X-LifeOps-Browser-Companion-Id": this.config.companionId,
      "X-Eliza-Browser-Companion-Id": this.config.companionId,
    };
  }

  async sync(
    request: CompanionSyncRequest,
  ): Promise<LifeOpsBrowserCompanionSyncResponse> {
    const response = await fetch(
      joinUrl(this.config.apiBaseUrl, "/api/lifeops/browser/companions/sync"),
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
        `/api/lifeops/browser/companions/sessions/${encodeURIComponent(sessionId)}/progress`,
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
        `/api/lifeops/browser/companions/sessions/${encodeURIComponent(sessionId)}/complete`,
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
