/**
 * HTTP client for ElizaCloud API.
 *
 * Typed request methods with automatic auth headers,
 * structured error handling, and WS URL construction.
 */

import { logger } from "@elizaos/core";
import {
  CloudApiError,
  type CloudApiErrorBody,
  InsufficientCreditsError,
} from "../types/cloud";

export class CloudApiClient {
  private baseUrl: string;
  private apiKey: string | undefined;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }
  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, "");
  }
  getBaseUrl(): string {
    return this.baseUrl;
  }
  getApiKey(): string | undefined {
    return this.apiKey;
  }

  /** Build a WebSocket URL from the base URL, replacing http(s) with ws(s). */
  buildWsUrl(path: string): string {
    return `${this.baseUrl.replace(/^http/, "ws")}${path}`;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  /**
   * POST without auth header — used for device-auth which doesn't
   * require a pre-existing API key.
   */
  async postUnauthenticated<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    return this.request<T>("POST", path, body, true);
  }

  // ── internals ──────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    skipAuth = false,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    logger.debug(`[CloudAPI] ${method} ${url}`);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (!skipAuth && this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    return this.handleResponse<T>(response);
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.includes("application/json")) {
      if (!response.ok) {
        throw new CloudApiError(response.status, {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
        });
      }
      return { success: true } as T;
    }

    const body = await response.json();

    if (!response.ok) {
      const err = body as CloudApiErrorBody;
      throw response.status === 402
        ? new InsufficientCreditsError(err)
        : new CloudApiError(response.status, err);
    }

    return body as T;
  }
}
