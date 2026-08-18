/** Defines the provider seam and a normalized JSON-over-HTTP implementation. */

import { MapsError } from "./errors.js";
import {
  type PlacePage,
  type PlaceRef,
  type PlaceSearchRequest,
  placePageSchema,
  placeRefSchema,
  type RoutePlan,
  type RoutePlanRequest,
  routePlanSchema,
} from "./types.js";

export interface MapsProviderAdapter {
  readonly id: string;
  readonly connectionId: string;
  searchPlaces(request: PlaceSearchRequest): Promise<PlacePage>;
  getPlace(providerPlaceId: string): Promise<PlaceRef | null>;
  planRoute(request: RoutePlanRequest): Promise<RoutePlan>;
}

export interface JsonMapsHttpAdapterOptions {
  id: string;
  connectionId: string;
  baseUrl: string;
  credential?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.round(seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function providerError(response: Response, body: unknown): MapsError {
  const providerCode =
    body && typeof body === "object" && "code" in body
      ? String((body as { code?: unknown }).code)
      : "";
  if (response.status === 401 && providerCode === "credential_expired") {
    return new MapsError("The maps connection has expired.", {
      code: "MAPS_AUTH_EXPIRED",
      context: { status: response.status },
    });
  }
  if (
    (response.status === 401 || response.status === 403) &&
    providerCode === "credential_revoked"
  ) {
    return new MapsError("The maps connection was revoked.", {
      code: "MAPS_AUTH_REVOKED",
      context: { status: response.status },
    });
  }
  if (response.status === 429) {
    return new MapsError("The maps provider is rate limited.", {
      code: "MAPS_RATE_LIMITED",
      retryAfterMs: retryAfterMs(response),
      context: { status: response.status },
    });
  }
  if (response.status >= 500) {
    return new MapsError("The maps provider failed.", {
      code: "MAPS_PROVIDER_FAILURE",
      context: { status: response.status },
    });
  }
  return new MapsError("The maps provider rejected the request.", {
    code: "MAPS_PROVIDER_REJECTED",
    context: { status: response.status },
  });
}

export class JsonMapsHttpAdapter implements MapsProviderAdapter {
  readonly id: string;
  readonly connectionId: string;
  private readonly baseUrl: string;
  private readonly credential?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: JsonMapsHttpAdapterOptions) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(options.id)) {
      throw new MapsError("Maps adapter id is invalid.", {
        code: "MAPS_INVALID_INPUT",
      });
    }
    if (!/^conn_[A-Za-z0-9_-]{16,}$/.test(options.connectionId)) {
      throw new MapsError("Maps adapter connection id must be opaque.", {
        code: "MAPS_INVALID_INPUT",
      });
    }
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new MapsError("Maps adapter endpoint must use HTTP or HTTPS.", {
        code: "MAPS_INVALID_INPUT",
      });
    }
    this.id = options.id;
    this.connectionId = options.connectionId;
    this.baseUrl = baseUrl.toString().replace(/\/$/, "");
    this.credential = options.credential;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async searchPlaces(request: PlaceSearchRequest): Promise<PlacePage> {
    if (!request.query.trim() || request.query.length > 500) {
      throw new MapsError("Place search requires a valid query.", {
        code: "MAPS_INVALID_INPUT",
      });
    }
    const url = new URL(`${this.baseUrl}/places/search`);
    url.searchParams.set("query", request.query.trim());
    if (request.cursor) url.searchParams.set("cursor", request.cursor);
    if (request.limit !== undefined)
      url.searchParams.set("limit", String(request.limit));
    if (request.near) {
      url.searchParams.set("latitude", String(request.near.latitude));
      url.searchParams.set("longitude", String(request.near.longitude));
    }
    return this.request(url, { method: "GET" }, placePageSchema);
  }

  async getPlace(providerPlaceId: string): Promise<PlaceRef | null> {
    if (!providerPlaceId.trim() || providerPlaceId.length > 512) {
      throw new MapsError("Place id is invalid.", {
        code: "MAPS_INVALID_INPUT",
      });
    }
    const url = new URL(
      `${this.baseUrl}/places/${encodeURIComponent(providerPlaceId.trim())}`,
    );
    const response = await this.fetchResponse(url, { method: "GET" });
    if (response.status === 404) return null;
    return this.decodeResponse(response, placeRefSchema);
  }

  async planRoute(request: RoutePlanRequest): Promise<RoutePlan> {
    const url = new URL(`${this.baseUrl}/routes`);
    return this.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
      routePlanSchema,
    );
  }

  private async request<T>(
    url: URL,
    init: RequestInit,
    schema: {
      safeParse(
        value: unknown,
      ): { success: true; data: T } | { success: false; error: unknown };
    },
  ): Promise<T> {
    return this.decodeResponse(await this.fetchResponse(url, init), schema);
  }

  private async fetchResponse(url: URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        ...init,
        headers: {
          ...init.headers,
          ...(this.credential
            ? { authorization: `Bearer ${this.credential}` }
            : {}),
          "x-maps-connection-id": this.connectionId,
        },
        signal: controller.signal,
      });
    } catch (error) {
      // error-policy:J2 Add a typed provider/network classification while
      // preserving the original transport failure as the cause.
      if (error instanceof Error && error.name === "AbortError") {
        throw new MapsError("The maps provider timed out.", {
          code: "MAPS_PROVIDER_TIMEOUT",
          cause: error,
        });
      }
      throw new MapsError("The maps provider connection failed.", {
        code: "MAPS_PROVIDER_NETWORK",
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async decodeResponse<T>(
    response: Response,
    schema: {
      safeParse(
        value: unknown,
      ): { success: true; data: T } | { success: false; error: unknown };
    },
  ): Promise<T> {
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      // error-policy:J2 Provider bytes are untrusted; preserve the JSON parse
      // failure without retaining or exposing the response body.
      throw new MapsError("The maps provider returned malformed JSON.", {
        code: "MAPS_MALFORMED_RESPONSE",
        cause: error,
        context: { status: response.status },
      });
    }
    if (!response.ok) throw providerError(response, body);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new MapsError(
        "The maps provider response did not match the contract.",
        {
          code: "MAPS_MALFORMED_RESPONSE",
          cause: parsed.error,
          context: { status: response.status },
        },
      );
    }
    return parsed.data;
  }
}
