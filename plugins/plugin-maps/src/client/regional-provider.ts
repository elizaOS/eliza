import {
  type Coordinate,
  MapsFailure,
  type MapsProvider,
  type Place,
  type Route,
  type TravelMode,
} from "./contracts.ts";
export type RegionalMap = {
  base: string;
  region: string;
  bounds: [number, number, number, number];
  attribution: string;
};
export interface RegionalOptions {
  baseUrl?: string;
  providerId: string;
  nativeGateway: string;
  developmentHosts: readonly string[];
  development: boolean;
  isNative(): boolean;
  developmentBuild(): Promise<boolean>;
  transport: {
    request(input: {
      path: string;
      requestId: string;
    }): Promise<{ status: number; data: string }>;
    cancel(input: { requestId: string }): Promise<void>;
  };
  configure(
    config: import("./contracts.ts").ProviderConfig,
    provider: MapsProvider,
  ): void;
}
/** Explicit trusted host configuration; no storage, chat, or public-provider discovery. */
export function createRegionalMaps(options: RegionalOptions) {
  options = { ...options, developmentHosts: [...options.developmentHosts] };
  let region: RegionalMap | undefined;
  const diagnostic = {
    stage: "idle",
    configured: false,
    native: false,
    development: false,
    error: "",
    nativeRequests: 0,
    nativeSuccesses: 0,
    lastStatus: 0,
    lastBytes: 0,
  };
  function regionalDiagnostics() {
    return { ...diagnostic };
  }
  function nativeRegion(base: string) {
    return options.isNative() && base === options.nativeGateway;
  }
  async function nativeRegionRequest(path: string, signal?: AbortSignal) {
    const requestId = crypto.randomUUID();
    signal?.throwIfAborted();
    const cancel = () => {
      void options.transport.cancel({ requestId }).catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      diagnostic.nativeRequests++;
      const result = await options.transport.request({ path, requestId });
      diagnostic.nativeSuccesses++;
      diagnostic.lastStatus = result.status;
      diagnostic.lastBytes = result.data.length;
      signal?.throwIfAborted();
      if (result.data.length > 2800000)
        throw new Error("Regional response too large");
      const bytes = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0));
      return { status: result.status, bytes };
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  function regionalMap() {
    return region;
  }
  async function request(base: string, path: string, signal?: AbortSignal) {
    try {
      if (nativeRegion(base)) {
        const response = await nativeRegionRequest(path, signal),
          result = JSON.parse(new TextDecoder().decode(response.bytes));
        if (response.status < 200 || response.status >= 300)
          throw new MapsFailure(
            response.status === 422 ? "unsupported" : "unavailable",
            typeof result.error === "string"
              ? result.error.slice(0, 300)
              : "Regional service unavailable.",
          );
        return result;
      }
      const response = await fetch(base + path, {
        signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 * 1024) throw new Error();
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const result = JSON.parse(new TextDecoder().decode(bytes));
      if (!response.ok)
        throw new MapsFailure(
          response.status === 422
            ? "unsupported"
            : response.status === 429
              ? "rate-limited"
              : "unavailable",
          typeof result.error === "string"
            ? result.error.slice(0, 300)
            : "Regional Maps request failed.",
        );
      return result;
    } catch (error) {
      if (error instanceof MapsFailure) throw error;
      if (signal?.aborted)
        throw new MapsFailure("cancelled", "Maps request cancelled.");
      throw new MapsFailure(
        "offline",
        "Regional Maps is unavailable. Check the configured service connection.",
      );
    }
  }
  class RegionalProvider implements MapsProvider {
    constructor(
      readonly providerId: string,
      readonly connectionId: string,
      private base: string,
    ) {}
    search(query: string, signal: AbortSignal): Promise<readonly Place[]> {
      return request(
        this.base,
        "/search?q=" + encodeURIComponent(query),
        signal,
      );
    }
    detail(id: string, signal: AbortSignal): Promise<Place | null> {
      return request(this.base, "/place?id=" + encodeURIComponent(id), signal);
    }
    route(
      from: Coordinate,
      to: Coordinate,
      mode: TravelMode,
      signal: AbortSignal,
    ): Promise<Route> {
      return request(
        this.base,
        "/route?" +
          new URLSearchParams({
            from: `${from.latitude},${from.longitude}`,
            to: `${to.latitude},${to.longitude}`,
            mode,
          }),
        signal,
      );
    }
  }
  /** Explicit build-time configuration. No endpoint discovery from user chat/storage. */
  async function initializeRegionalMaps(signal?: AbortSignal) {
    diagnostic.error = "";
    const raw = options.baseUrl;
    diagnostic.configured = !!raw;
    diagnostic.native = options.isNative();
    if (!raw) {
      diagnostic.stage = "no-configuration";
      return;
    }
    try {
      diagnostic.stage = "native-build-check";
      const url = new URL(raw);
      const development = options.isNative()
        ? await options.developmentBuild()
        : options.development;
      diagnostic.development = development;
      diagnostic.stage = "endpoint-validation";
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/" ||
        !(
          url.protocol === "https:" ||
          (development &&
            url.protocol === "http:" &&
            options.developmentHosts.includes(url.hostname))
        )
      )
        throw new Error("Maps endpoint must use HTTPS.");
      if (
        options.isNative() &&
        url.protocol === "http:" &&
        url.origin !== options.nativeGateway
      )
        throw new Error("Use the fixed debug regional gateway.");
      diagnostic.stage = "capabilities-request";
      const base = url.origin,
        meta = await request(base, "/capabilities", signal);
      diagnostic.stage = "capabilities-validation";
      if (
        meta.providerId !== options.providerId ||
        typeof meta.region !== "string" ||
        meta.region.length > 100 ||
        !Array.isArray(meta.bounds) ||
        meta.bounds.length !== 4 ||
        !meta.bounds.every(Number.isFinite) ||
        typeof meta.attribution !== "string" ||
        meta.attribution.length > 1000
      )
        throw new Error("Invalid regional Maps metadata.");
      const caps = meta.capabilities;
      if (
        !caps ||
        caps.map !== true ||
        caps.search !== true ||
        caps.placeDetails !== true ||
        !Array.isArray(caps.modes) ||
        caps.modes.length > 3 ||
        !caps.modes.every((mode: string) =>
          ["drive", "walk", "bicycle"].includes(mode),
        ) ||
        caps.traffic !== "none" ||
        caps.transit !== "none" ||
        !caps.offline ||
        Object.values(caps.offline).some((v) => v !== false)
      )
        throw new Error("Invalid regional capabilities");
      region = {
        base,
        region: meta.region,
        bounds: meta.bounds,
        attribution: meta.attribution,
      };
      diagnostic.stage = "ready";
      options.configure(
        {
          status: "configured",
          providerId: meta.providerId,
          connectionId: meta.connectionId,
          revision: meta.revision,
          capabilities: meta.capabilities,
        },
        new RegionalProvider(meta.providerId, meta.connectionId, base),
      );
    } catch (error) {
      diagnostic.error =
        error instanceof MapsFailure ? error.code : "initialization-failed";
      region =
        undefined; /* Remain explicitly unconfigured. No public-provider fallback. */
    }
  }

  return {
    regionalDiagnostics,
    nativeRegion,
    nativeRegionRequest,
    regionalMap,
    initializeRegionalMaps,
  };
}
