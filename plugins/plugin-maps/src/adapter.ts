/**
 * Defines the provider seam and a bounded, SSRF-guarded JSON-over-HTTP adapter.
 * Credentials are pinned to one configured origin; redirects are rejected and
 * every production connection uses core's DNS-pinned transport.
 */

import {
  fetchWithSsrfGuard,
  type GuardedFetchOptions,
  isBlockedHostname,
  isPrivateIpAddress,
  SsrfBlockedError,
} from "@elizaos/core";
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
  readonly supportsCrossProviderRoutes?: boolean;
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
  responseByteLimit?: number;
  /** Explicit transport seam for deterministic SSRF/adversarial tests only. */
  testTransport?: Pick<
    GuardedFetchOptions,
    "fetchImpl" | "pinnedFetchImpl" | "lookupFn"
  >;
  /** Allows an injected test transport to reach its loopback fake upstream. */
  allowPrivateNetworkForTests?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

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
  if (response.status === 401 && providerCode !== "credential_revoked") {
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
  private readonly baseOrigin: string;
  private readonly credential?: string;
  private readonly timeoutMs: number;
  private readonly responseByteLimit: number;
  private readonly testTransport?: JsonMapsHttpAdapterOptions["testTransport"];
  private readonly allowPrivateNetworkForTests: boolean;

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
    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl);
    } catch (error) {
      throw new MapsError("Maps adapter endpoint is invalid.", {
        code: "MAPS_INVALID_INPUT",
        cause: error,
      });
    }
    const allowPrivateTest = options.allowPrivateNetworkForTests === true;
    if (allowPrivateTest && !options.testTransport?.fetchImpl) {
      throw new MapsError(
        "Private-network maps endpoints require an explicit injected test transport.",
        { code: "MAPS_INVALID_INPUT" },
      );
    }
    if (
      baseUrl.protocol !== "https:" &&
      !(allowPrivateTest && baseUrl.protocol === "http:")
    ) {
      throw new MapsError("Maps adapter endpoint must use HTTPS.", {
        code: "MAPS_INVALID_INPUT",
      });
    }
    if (
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      throw new MapsError(
        "Maps adapter endpoint cannot contain userinfo, query, or fragment data.",
        { code: "MAPS_INVALID_INPUT" },
      );
    }
    if (baseUrl.pathname !== "/") {
      throw new MapsError("Maps adapter endpoint must be an origin URL.", {
        code: "MAPS_INVALID_INPUT",
      });
    }
    if (
      !allowPrivateTest &&
      (isBlockedHostname(baseUrl.hostname) ||
        isPrivateIpAddress(baseUrl.hostname))
    ) {
      throw new MapsError("Maps adapter endpoint is not a public origin.", {
        code: "MAPS_ENDPOINT_BLOCKED",
      });
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isFinite(timeoutMs) ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < MIN_TIMEOUT_MS ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new MapsError(
        `Maps adapter timeout must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} ms.`,
        { code: "MAPS_INVALID_INPUT" },
      );
    }
    const responseByteLimit =
      options.responseByteLimit ?? DEFAULT_RESPONSE_BYTES;
    if (
      !Number.isFinite(responseByteLimit) ||
      !Number.isInteger(responseByteLimit) ||
      responseByteLimit < 1 ||
      responseByteLimit > MAX_RESPONSE_BYTES
    ) {
      throw new MapsError("Maps adapter response byte limit is invalid.", {
        code: "MAPS_INVALID_INPUT",
      });
    }
    this.id = options.id;
    this.connectionId = options.connectionId;
    this.baseOrigin = baseUrl.origin;
    this.credential = options.credential;
    this.timeoutMs = timeoutMs;
    this.responseByteLimit = responseByteLimit;
    this.testTransport = options.testTransport;
    this.allowPrivateNetworkForTests = allowPrivateTest;
  }

  async searchPlaces(request: PlaceSearchRequest): Promise<PlacePage> {
    if (!request.query.trim() || request.query.length > 500) {
      throw new MapsError("Place search requires a valid query.", {
        code: "MAPS_INVALID_INPUT",
      });
    }
    const url = new URL("/places/search", this.baseOrigin);
    url.searchParams.set("query", request.query.trim());
    if (request.cursor) url.searchParams.set("cursor", request.cursor);
    if (request.limit !== undefined)
      url.searchParams.set("limit", String(request.limit));
    if (request.near) {
      url.searchParams.set("latitude", String(request.near.latitude));
      url.searchParams.set("longitude", String(request.near.longitude));
    }
    const page = await this.request(url, { method: "GET" }, placePageSchema);
    for (const place of page.places) this.assertPlaceProvider(place, "search");
    return page;
  }

  async getPlace(providerPlaceId: string): Promise<PlaceRef | null> {
    if (!providerPlaceId.trim() || providerPlaceId.length > 512) {
      throw new MapsError("Place id is invalid.", {
        code: "MAPS_INVALID_INPUT",
      });
    }
    const url = new URL(
      `/places/${encodeURIComponent(providerPlaceId.trim())}`,
      this.baseOrigin,
    );
    const guarded = await this.fetchResponse(url, { method: "GET" });
    try {
      if (guarded.response.status === 404) {
        await guarded.response.body?.cancel();
        return null;
      }
      const place = await this.decodeResponse(guarded.response, placeRefSchema);
      this.assertPlaceProvider(place, "detail");
      return place;
    } finally {
      await guarded.release();
    }
  }

  async planRoute(request: RoutePlanRequest): Promise<RoutePlan> {
    for (const [endpoint, place] of [
      ["origin", request.origin],
      ["destination", request.destination],
    ] as const) {
      if (place.provider !== this.id && place.provider !== "coordinates") {
        throw new MapsError(
          "Route endpoints must belong to the selected maps provider.",
          {
            code: "MAPS_INVALID_INPUT",
            context: {
              adapterId: this.id,
              endpoint,
              endpointProvider: place.provider,
            },
          },
        );
      }
    }
    const url = new URL("/routes", this.baseOrigin);
    const route = await this.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
      routePlanSchema,
    );
    if (route.provider !== this.id) {
      throw new MapsError("Maps route response spoofed another provider.", {
        code: "MAPS_MALFORMED_RESPONSE",
        context: { adapterId: this.id, responseProvider: route.provider },
      });
    }
    this.assertPlaceProvider(route.origin, "route origin");
    this.assertPlaceProvider(route.destination, "route destination");
    return route;
  }

  private assertPlaceProvider(place: PlaceRef, surface: string): void {
    if (place.provider !== this.id) {
      throw new MapsError("Maps place response spoofed another provider.", {
        code: "MAPS_MALFORMED_RESPONSE",
        context: {
          adapterId: this.id,
          responseProvider: place.provider,
          surface,
        },
      });
    }
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
    const guarded = await this.fetchResponse(url, init);
    try {
      return await this.decodeResponse(guarded.response, schema);
    } finally {
      await guarded.release();
    }
  }

  private async fetchResponse(
    url: URL,
    init: RequestInit,
  ): ReturnType<typeof fetchWithSsrfGuard> {
    if (url.origin !== this.baseOrigin) {
      throw new MapsError(
        "Maps request escaped the configured provider origin.",
        {
          code: "MAPS_ENDPOINT_BLOCKED",
        },
      );
    }
    const headers = new Headers(init.headers);
    if (this.credential)
      headers.set("authorization", `Bearer ${this.credential}`);
    headers.set("x-maps-connection-id", this.connectionId);
    try {
      return await fetchWithSsrfGuard({
        url: url.href,
        init: { ...init, headers, redirect: "manual" },
        maxRedirects: 0,
        timeoutMs: this.timeoutMs,
        policy: this.allowPrivateNetworkForTests
          ? { allowPrivateNetwork: true }
          : undefined,
        ...this.testTransport,
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
      if (error instanceof SsrfBlockedError) {
        throw new MapsError(
          "The maps provider endpoint was blocked by network policy.",
          {
            code: "MAPS_ENDPOINT_BLOCKED",
            cause: error,
          },
        );
      }
      throw new MapsError("The maps provider connection failed.", {
        code: "MAPS_PROVIDER_NETWORK",
        cause: error,
      });
    }
  }

  private async readBoundedBody(response: Response): Promise<string> {
    const declared = response.headers.get("content-length");
    if (
      declared &&
      /^\d+$/.test(declared) &&
      Number(declared) > this.responseByteLimit
    ) {
      throw new MapsError(
        "The maps provider response exceeded the byte limit.",
        {
          code: "MAPS_RESPONSE_TOO_LARGE",
          context: { status: response.status, limit: this.responseByteLimit },
        },
      );
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let body = "";
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > this.responseByteLimit) {
          await reader.cancel("maps response exceeded byte limit");
          throw new MapsError(
            "The maps provider response exceeded the byte limit.",
            {
              code: "MAPS_RESPONSE_TOO_LARGE",
              context: {
                status: response.status,
                limit: this.responseByteLimit,
              },
            },
          );
        }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
      return body;
    } catch (error) {
      if (error instanceof MapsError) throw error;
      // error-policy:J2 Provider bytes are untrusted; preserve bounded read and
      // UTF-8 failures without retaining or exposing response content.
      throw new MapsError(
        "The maps provider response body could not be read.",
        {
          code: "MAPS_MALFORMED_RESPONSE",
          cause: error,
          context: { status: response.status },
        },
      );
    } finally {
      reader.releaseLock();
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
    if (!response.ok) {
      let errorBody: unknown;
      if (response.status === 401 || response.status === 403) {
        const text = await this.readBoundedBody(response);
        if (text) {
          try {
            errorBody = JSON.parse(text);
          } catch {
            // error-policy:J3 An error envelope is optional; HTTP status remains
            // authoritative and malformed diagnostic bytes are discarded.
            errorBody = undefined;
          }
        }
      } else {
        await response.body?.cancel();
      }
      throw providerError(response, errorBody);
    }
    const text = await this.readBoundedBody(response);
    let body: unknown;
    try {
      body = JSON.parse(text);
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
