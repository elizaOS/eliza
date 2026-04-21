import { WebPlugin } from "@capacitor/core";
import type {
  StartWebsiteBlockOptions,
  StartWebsiteBlockResult,
  StopWebsiteBlockResult,
  WebsiteBlockerPermissionResult,
  WebsiteBlockerStatus,
} from "./definitions";

interface ElizaWindow extends Window {
  __ELIZA_API_BASE__?: string;
  __ELIZA_API_TOKEN__?: string;
}

export class WebsiteBlockerWeb extends WebPlugin {
  private apiBase(): string {
    const global =
      typeof window !== "undefined"
        ? (window as ElizaWindow).__ELIZA_API_BASE__
        : undefined;
    if (typeof global === "string" && global.trim().length > 0) {
      return global;
    }
    return "";
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
    const global =
      typeof window !== "undefined"
        ? (window as ElizaWindow).__ELIZA_API_BASE__
        : undefined;
    if (typeof global === "string" && global.trim().length > 0) {
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
    return await this.requestJson<StartWebsiteBlockResult>(
      "/api/website-blocker",
      {
        method: "PUT",
        body: JSON.stringify(options),
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
      reason?: string;
    }>("/api/permissions/website-blocking");
    return {
      status: permission.status,
      canRequest: permission.canRequest,
      reason: permission.reason,
    };
  }

  async requestPermissions(): Promise<WebsiteBlockerPermissionResult> {
    const permission = await this.requestJson<{
      status: WebsiteBlockerPermissionResult["status"];
      canRequest: boolean;
      reason?: string;
    }>("/api/permissions/website-blocking/request", {
      method: "POST",
    });
    return {
      status: permission.status,
      canRequest: permission.canRequest,
      reason: permission.reason,
    };
  }

  async openSettings(): Promise<{ opened: boolean }> {
    if (!this.canReachApi()) {
      return { opened: false };
    }
    return await this.requestJson<{ opened: boolean }>(
      "/api/permissions/website-blocking/open-settings",
      {
        method: "POST",
      },
    );
  }
}
