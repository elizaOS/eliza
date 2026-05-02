/**
 * @module calendly-client
 * @description Thin wrapper around the Calendly v2 REST API.
 *
 * The client is intentionally small: it owns auth-header construction, URL
 * building for the endpoints we consume, and JSON decoding. It does not
 * cache, retry, or interpret business meaning — that lives in CalendlyService
 * and the actions that sit above it.
 *
 * `fetchImpl` is injectable so tests can drive the client without reaching
 * the network.
 */

import type {
  CalendlyEventType,
  CalendlyInvitee,
  CalendlyListResponse,
  CalendlyScheduledEvent,
  CalendlyUser,
} from "./types.js";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface CalendlyClientOptions {
  accessToken: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

const DEFAULT_BASE_URL = "https://api.calendly.com";

export class CalendlyApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = "CalendlyApiError";
    this.status = status;
    this.body = body;
  }
}

export class CalendlyClient {
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: CalendlyClientOptions) {
    if (!options.accessToken || options.accessToken.length === 0) {
      throw new Error("CalendlyClient requires a non-empty accessToken");
    }
    this.accessToken = options.accessToken;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    const injected = options.fetchImpl;
    if (injected) {
      this.fetchImpl = injected;
    } else if (typeof globalThis.fetch === "function") {
      this.fetchImpl = globalThis.fetch.bind(globalThis);
    } else {
      throw new Error(
        "CalendlyClient requires a fetchImpl when global fetch is unavailable",
      );
    }
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) {
          continue;
        }
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async request<T>(
    method: string,
    path: string,
    options?: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      expectEmpty?: boolean;
    },
  ): Promise<T> {
    const url = this.buildUrl(path, options?.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers };
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    const response = await this.fetchImpl(url, init);
    if (!response.ok) {
      const text = await response.text();
      throw new CalendlyApiError(
        response.status,
        text,
        `Calendly ${method} ${path} failed: ${response.status} ${text}`,
      );
    }
    if (options?.expectEmpty) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  async getCurrentUser(): Promise<CalendlyUser> {
    const body = await this.request<{ resource: CalendlyUser }>(
      "GET",
      "/users/me",
    );
    return body.resource;
  }

  async listEventTypes(
    userUri: string,
  ): Promise<CalendlyListResponse<CalendlyEventType>> {
    return this.request<CalendlyListResponse<CalendlyEventType>>(
      "GET",
      "/event_types",
      { query: { user: userUri, active: "true" } },
    );
  }

  async getScheduledEvent(uuid: string): Promise<CalendlyScheduledEvent> {
    const body = await this.request<{ resource: CalendlyScheduledEvent }>(
      "GET",
      `/scheduled_events/${encodeURIComponent(uuid)}`,
    );
    return body.resource;
  }

  async getInvitee(
    eventUuid: string,
    inviteeUuid: string,
  ): Promise<CalendlyInvitee> {
    const body = await this.request<{ resource: CalendlyInvitee }>(
      "GET",
      `/scheduled_events/${encodeURIComponent(eventUuid)}/invitees/${encodeURIComponent(inviteeUuid)}`,
    );
    return body.resource;
  }

  async cancelScheduledEvent(uuid: string, reason?: string): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/scheduled_events/${encodeURIComponent(uuid)}/cancellation`,
      {
        body: reason ? { reason } : {},
        expectEmpty: true,
      },
    );
  }
}
