import {
  boundedText,
  type Coordinate,
  coordinate,
  MapsFailure,
  type MapsProvider,
  type Place,
  type ProviderConfig,
  place,
  type Route,
  type TravelMode,
} from "./contracts.ts";

/** Exact Cloud Maps routes (#412) that the managed-service transport admits. */
export type CloudMapsRoute =
  | "capabilities"
  | "geocode"
  | "reverse"
  | "places/search"
  | "places/details"
  | "routes"
  | "tiles/viewport";
/** Account-bound Cloud request. Queries and coordinates travel only in the JSON body. */
export type CloudMapsRequest = (
  route: CloudMapsRoute,
  signal: AbortSignal,
  body?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
export type CloudMapsRegion = Readonly<{
  id: string;
  name: string;
  bounds: readonly [number, number, number, number];
}>;
/** Who receives a request's text and coordinates (Cloud `capabilities.disclosure`). */
export type CloudMapsDisclosure = Readonly<{
  recipients: readonly Readonly<{
    role: "gateway" | "search" | "routing";
    name: string;
    operator: string;
  }>[];
  cloudRecords: "operation-and-result-code";
}>;
export type CloudMapsSources = Readonly<{
  data: string;
  search: string;
  routing: string;
}>;
/** Raster tiles Cloud proxies (`capabilities.tiles`); fetched with the host's Cloud credential. */
export type CloudMapsTiles = Readonly<{
  /** Path template on the Cloud origin, `/api/v1/maps/tiles/{z}/{x}/{y}`. */
  urlTemplate: string;
  minZoom: number;
  maxZoom: number;
  tileSize: number;
  attribution: string;
}>;
export type CloudMapsCoverage = Readonly<{
  providerId: string;
  revision: string;
  attribution: string;
  regions: readonly CloudMapsRegion[];
  sources?: CloudMapsSources;
  disclosure?: CloudMapsDisclosure;
  tiles?: CloudMapsTiles;
}>;
/**
 * One Cloud tile (`GET {urlTemplate}`) with the host's Cloud credential and a
 * fresh `Idempotency-Key`; resolves to the image bytes.
 */
export type CloudMapsTileRequest = (
  z: number,
  x: number,
  y: number,
  signal: AbortSignal,
) => Promise<ArrayBuffer>;
/** A raster basemap drawn from Cloud tiles (map-plane `CloudRasterBasemap`). */
export type CloudMapsBasemap = Readonly<{
  kind: "cloud-raster";
  attribution: string;
  minZoom: number;
  maxZoom: number;
  tileSize: number;
  tile: CloudMapsTileRequest;
  /** Provider copyright for the visible area. */
  copyright(
    view: Readonly<{
      zoom: number;
      north: number;
      south: number;
      east: number;
      west: number;
    }>,
    signal: AbortSignal,
  ): Promise<string>;
}>;
/** A Cloud request limit read from a refusal: an exhausted period allowance or a rate limit. */
export type CloudMapsServiceLimit = Readonly<{
  kind: "allowance-exhausted" | "rate-limited" | string;
  retryAfterMs: number | null;
  resetsAt: number | null;
}>;
export type CloudMapsOptions = Readonly<{
  /** Reads the limit from a refusal; hosts may pass their shared subscription reader. */
  serviceLimit?: (error: unknown, now: number) => CloudMapsServiceLimit | null;
  /** Fetches Cloud tiles; without it the provider reports no map plane even when Cloud serves tiles. */
  tileRequest?: () => CloudMapsTileRequest;
  /** Whether a transport error means the device is offline; hosts may pass their connection classifier. */
  isOffline?: (error: unknown) => boolean;
}>;

/** Human wait time for a retry, rounded up. */
export function retryWait(ms: number): string {
  const secs = Math.max(1, Math.ceil(ms / 1000));
  if (secs < 90) return `about ${secs} second${secs === 1 ? "" : "s"}`;
  const minutes = Math.ceil(secs / 60);
  if (minutes < 90) return `about ${minutes} minutes`;
  return `about ${Math.ceil(minutes / 60)} hours`;
}

/**
 * Default offline test for a transport error. "Connection request failed" is
 * what the native and browser connection transports reject with. A cancelled
 * request is never offline.
 */
export function cloudMapsOffline(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (/cancel/i.test(error.message)) return false;
  return (
    error.message === "Connection request failed" ||
    /network|offline|timed out|failed to fetch|load failed|internet/i.test(
      error.message,
    )
  );
}

const DAY_MS = 86_400_000;
const MAX_PERIOD_RESET_MS = 400 * DAY_MS;

/**
 * Limit fields of a Cloud Maps refusal body: `code`, `retryAfterSeconds` and
 * `resetAt`. A retry hint longer than a day is not a countdown; for an
 * exhausted period allowance it is the reset when no explicit one was given.
 */
export function cloudMapsServiceLimit(
  error: unknown,
  now: number,
): CloudMapsServiceLimit | null {
  const data =
    error && typeof error === "object"
      ? (error as { data?: unknown }).data
      : undefined;
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  const allowance = row.code === "allowance_exhausted";
  const seconds =
    typeof row.retryAfterSeconds === "number"
      ? row.retryAfterSeconds
      : typeof row.retryAfterSeconds === "string" &&
          /^\d+(\.\d+)?$/.test(row.retryAfterSeconds.trim())
        ? Number(row.retryAfterSeconds)
        : Number.NaN;
  let retryAfterMs =
    Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  const resetValue = row.resetAt ?? row.resetsAt;
  const reset =
    typeof resetValue === "string"
      ? Date.parse(resetValue)
      : typeof resetValue === "number" && resetValue > 0
        ? resetValue < 1e12
          ? resetValue * 1000
          : resetValue
        : Number.NaN;
  let resetsAt = Number.isFinite(reset) ? reset : null;
  if (retryAfterMs !== null && retryAfterMs > DAY_MS) {
    if (allowance && resetsAt === null && retryAfterMs <= MAX_PERIOD_RESET_MS)
      resetsAt = now + retryAfterMs;
    retryAfterMs = null;
  }
  return {
    kind: allowance ? "allowance-exhausted" : "rate-limited",
    retryAfterMs,
    resetsAt,
  };
}

/** Names each service that receives search text and route points, or "" for none. */
export function describeLocationRecipients(
  recipients: CloudMapsDisclosure["recipients"],
  gatewayFallback?: string,
): string {
  const gateway =
    recipients.find((recipient) => recipient.role === "gateway")?.name ??
    gatewayFallback;
  const targets = [
    ...(gateway ? [gateway] : []),
    ...recipients
      .filter((recipient) => recipient.role !== "gateway")
      .map(
        (recipient) =>
          `${recipient.name} for ${recipient.role}, operated by ${recipient.operator}`,
      ),
  ];
  return targets.length
    ? `Searches, search areas and route points are sent to ${targets.join(" and ")}.`
    : "";
}

/** One sentence for location controls: who receives search text and coordinates. */
export function describeMapsDisclosure(
  disclosure: CloudMapsDisclosure | undefined,
): string {
  if (!disclosure) return "";
  return `${describeLocationRecipients(disclosure.recipients, "Cloud Maps")} Cloud keeps only the request type and result, not your searches or locations.`;
}

function disclosureOf(value: unknown): CloudMapsDisclosure | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as { recipients?: unknown; cloudRecords?: unknown };
  if (
    row.cloudRecords !== "operation-and-result-code" ||
    !Array.isArray(row.recipients) ||
    row.recipients.length < 1 ||
    row.recipients.length > 8
  )
    return undefined;
  const recipients = row.recipients.map((entry) => {
    const item =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : {};
    return (item.role === "gateway" ||
      item.role === "search" ||
      item.role === "routing") &&
      boundedText(item.name, 100) &&
      boundedText(item.operator, 100)
      ? Object.freeze({
          role: item.role,
          name: item.name as string,
          operator: item.operator as string,
        })
      : undefined;
  });
  return recipients.every(Boolean)
    ? Object.freeze({
        recipients: Object.freeze(
          recipients as CloudMapsDisclosure["recipients"][number][],
        ),
        cloudRecords: "operation-and-result-code" as const,
      })
    : undefined;
}

function sourcesOf(value: unknown): CloudMapsSources | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  return boundedText(row.data, 100) &&
    boundedText(row.search, 100) &&
    boundedText(row.routing, 100)
    ? Object.freeze({
        data: row.data as string,
        search: row.search as string,
        routing: row.routing as string,
      })
    : undefined;
}

const MODES: readonly TravelMode[] = ["drive", "walk", "bicycle", "transit"];

function tilesOf(value: unknown): CloudMapsTiles | undefined {
  if (!value || typeof value !== "object") return undefined;
  const t = value as Record<string, unknown>;
  const zoom = (v: unknown) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 22;
  return t.urlTemplate === "/api/v1/maps/tiles/{z}/{x}/{y}" &&
    zoom(t.minZoom) &&
    zoom(t.maxZoom) &&
    (t.minZoom as number) <= (t.maxZoom as number) &&
    (t.tileSize === 256 || t.tileSize === 512) &&
    boundedText(t.attribution, 200)
    ? Object.freeze({
        urlTemplate: t.urlTemplate,
        minZoom: t.minZoom as number,
        maxZoom: t.maxZoom as number,
        tileSize: t.tileSize as number,
        attribution: t.attribution as string,
      })
    : undefined;
}

function validBounds(
  value: unknown,
): value is [number, number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((v) => typeof v === "number" && Number.isFinite(v))
  )
    return false;
  const [west, south, east, north] = value as number[];
  return (
    west >= -180 &&
    east <= 180 &&
    south >= -90 &&
    north <= 90 &&
    west < east &&
    south < north
  );
}

/** Whether a point is inside any Cloud coverage region. */
export function insideCloudCoverage(
  coverage: Pick<CloudMapsCoverage, "regions">,
  point: Coordinate,
): boolean {
  return coverage.regions.some(
    ({ bounds: [west, south, east, north] }) =>
      point.longitude >= west &&
      point.longitude <= east &&
      point.latitude >= south &&
      point.latitude <= north,
  );
}

/** Typed device failure for a Cloud refusal. Cloud never sends guessed data, so no fallback is tried. */
export function cloudMapsFailure(
  error: unknown,
  signal?: AbortSignal,
  serviceLimit: NonNullable<
    CloudMapsOptions["serviceLimit"]
  > = cloudMapsServiceLimit,
  isOffline: NonNullable<CloudMapsOptions["isOffline"]> = cloudMapsOffline,
): MapsFailure {
  if (error instanceof MapsFailure) return error;
  if (signal?.aborted)
    return new MapsFailure("cancelled", "Maps request cancelled.");
  const failure = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    data?: unknown;
  } | null;
  if (
    failure &&
    typeof failure === "object" &&
    failure.name === "CloudProtocolError"
  ) {
    if (failure.code === "invalid-response")
      return new MapsFailure(
        "invalid-response",
        "Cloud Maps sent an invalid response.",
      );
    if (failure.code !== "http")
      return new MapsFailure("unauthorized", "Sign in to Cloud to use Maps.");
    const code =
      failure.data && typeof failure.data === "object"
        ? (failure.data as { code?: unknown }).code
        : undefined;
    // Cloud saw the request abort before admission: nothing was dispatched or counted.
    if (code === "maps_request_cancelled")
      return new MapsFailure("cancelled", "Maps request cancelled.");
    if (code === "maps_allowance_unconfigured")
      return new MapsFailure(
        "unconfigured",
        "Cloud Maps is not available yet.",
      );
    if (code === "maps_funding_changed")
      return new MapsFailure(
        "unavailable",
        "Your plan changed. Try the Maps request again.",
      );
    if (
      code === "maps_admission_unknown" ||
      code === "maps_request_already_admitted" ||
      code === "maps_request_identity_conflict"
    )
      return new MapsFailure(
        "unavailable",
        "This Maps request could not be confirmed. It will not retry automatically.",
      );
    switch (failure.status) {
      case 402:
        return new MapsFailure(
          "unauthorized",
          "Add balance or choose a plan to use Maps.",
        );
      case 401:
        return new MapsFailure("unauthorized", "Sign in to Cloud to use Maps.");
      // An authenticated 404 means this Cloud deployment does not serve Maps yet (#412).
      case 404:
        return new MapsFailure(
          "unconfigured",
          "Cloud Maps is not available yet.",
        );
      case 403:
        return new MapsFailure(
          "unauthorized",
          code === "subscription_required"
            ? "Maps needs an active Cloud subscription."
            : "Cloud refused this Maps request.",
        );
      case 429: {
        const now = Date.now(),
          limit = serviceLimit(error, now);
        if (limit?.kind === "allowance-exhausted") {
          const reset =
            limit.resetsAt != null &&
            limit.resetsAt > now &&
            limit.resetsAt - now <= 400 * 86400000
              ? ` It resets ${new Date(limit.resetsAt).toLocaleString()}.`
              : limit.retryAfterMs != null
                ? ` It resets in ${retryWait(limit.retryAfterMs)}.`
                : "";
          return new MapsFailure(
            "rate-limited",
            `You have used your Maps allowance for this period.${reset}`,
          );
        }
        const retryMs =
          limit?.retryAfterMs ??
          (limit?.resetsAt != null &&
          limit.resetsAt > now &&
          limit.resetsAt - now <= 86400000
            ? limit.resetsAt - now
            : null);
        const wait =
          retryMs != null
            ? `Try again in ${retryWait(retryMs)}.`
            : "Try again later.";
        return new MapsFailure(
          "rate-limited",
          `Maps request limit reached. ${wait}`,
        );
      }
      case 422:
        return new MapsFailure(
          "unsupported",
          code === "no_route"
            ? "No route is available between these places."
            : code === "unsupported_mode"
              ? "This travel mode is not available from Cloud Maps."
              : "This location is outside Cloud Maps coverage.",
        );
      case 503:
        return code === "maps_not_configured"
          ? new MapsFailure("unconfigured", "Cloud Maps is not available yet.")
          : new MapsFailure(
              "unavailable",
              "Cloud Maps is temporarily unavailable. Try again later.",
            );
      default:
        return new MapsFailure(
          failure.status === 502 ? "invalid-response" : "unavailable",
          "Cloud Maps could not complete this request.",
        );
    }
  }
  if (isOffline(error))
    return new MapsFailure(
      "offline",
      "Cloud Maps is unreachable. Check the connection.",
    );
  return new MapsFailure(
    "unavailable",
    "Cloud Maps could not complete this request.",
  );
}

/**
 * Cloud Maps as the device provider. Cloud supplies places and routes only; GPS,
 * the active route and guidance stay on the phone. Cloud serves no tiles, so the
 * capabilities report no map plane.
 */
export function createCloudMaps(
  captureRequest: () => CloudMapsRequest,
  configure: (config: ProviderConfig, provider?: MapsProvider) => void,
  options: CloudMapsOptions = {},
) {
  const serviceLimit = options.serviceLimit ?? cloudMapsServiceLimit;
  const isOffline = options.isOffline ?? cloudMapsOffline;
  let generation = 0;
  let coverage: CloudMapsCoverage | undefined;
  let tileFetch: CloudMapsTileRequest | undefined;
  let viewportRequest: CloudMapsRequest | undefined;
  let cooldown: { until: number; error: unknown } | undefined;
  // Only a provider this instance installed is retired; another configured provider is left alone.
  let installed = false;
  const uninstall = () => {
    if (installed) {
      installed = false;
      configure({ status: "unconfigured" });
    }
  };
  const diagnostic = { configured: false, error: "", message: "" };
  async function call(
    request: CloudMapsRequest,
    route: CloudMapsRoute,
    signal: AbortSignal,
    body?: Record<string, unknown>,
  ) {
    try {
      return await request(route, signal, body);
    } catch (error) {
      throw cloudMapsFailure(error, signal, serviceLimit, isOffline);
    }
  }
  class CloudProvider implements MapsProvider {
    constructor(
      readonly providerId: string,
      readonly connectionId: string,
      private readonly send: CloudMapsRequest,
      private readonly alternatives: boolean,
    ) {}
    private places(value: unknown): readonly Place[] {
      if (!Array.isArray(value) || value.length > 100)
        throw new MapsFailure(
          "invalid-response",
          "The Maps search response is invalid.",
        );
      return value.map((item) => place(item, this.providerId));
    }
    async search(
      query: string,
      signal: AbortSignal,
      options: Readonly<{ near?: Coordinate }> = {},
    ): Promise<readonly Place[]> {
      const text = query.trim();
      if (!text) return [];
      if (text.length > 300)
        throw new MapsFailure("unsupported", "Search text is too long.");
      // `near` is a point already on the map; the caller never reads location for it.
      const near = options.near ? coordinate(options.near) : undefined;
      return this.places(
        (
          await call(this.send, "places/search", signal, {
            query: text,
            ...(near ? { near } : {}),
          })
        ).places,
      );
    }
    async detail(id: string, signal: AbortSignal): Promise<Place | null> {
      if (!boundedText(id, 512)) return null;
      const result = (await call(this.send, "places/details", signal, { id }))
        .place;
      return result === null ? null : place(result, this.providerId);
    }
    private async fetchRoutes(
      from: Coordinate,
      to: Coordinate,
      mode: TravelMode,
      signal: AbortSignal,
      alternatives: boolean,
    ): Promise<readonly Route[]> {
      const routes = (
        await call(this.send, "routes", signal, {
          from: coordinate(from),
          to: coordinate(to),
          mode,
          ...(alternatives ? { alternatives: true } : {}),
        })
      ).routes;
      // The controller validates each route's identity, endpoints, geometry and steps.
      if (
        !Array.isArray(routes) ||
        routes.length < 1 ||
        routes.length > (alternatives ? 3 : 1) ||
        !routes.every((route) => route && typeof route === "object")
      )
        throw new MapsFailure(
          "invalid-response",
          "The Maps route response is invalid.",
        );
      return routes as Route[];
    }
    async route(
      from: Coordinate,
      to: Coordinate,
      mode: TravelMode,
      signal: AbortSignal,
    ): Promise<Route> {
      return (
        await this.fetchRoutes(from, to, mode, signal, false)
      )[0] as Route;
    }
    /** One admitted request; Cloud returns the recommended route first. */
    routes(
      from: Coordinate,
      to: Coordinate,
      mode: TravelMode,
      signal: AbortSignal,
    ): Promise<readonly Route[]> {
      return this.fetchRoutes(from, to, mode, signal, this.alternatives);
    }
  }
  /** Reads coverage and configures the provider. On failure Maps stays unconfigured; nothing falls back. */
  async function initializeCloudMaps(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    const attempt = ++generation;
    coverage = undefined;
    tileFetch = undefined;
    viewportRequest = undefined;
    uninstall();
    diagnostic.configured = true;
    diagnostic.error = "";
    diagnostic.message = "";
    try {
      const captured = captureRequest();
      // One server pause applies to every data request in this account, including tiles.
      // Coverage can still restore the existing map while those requests wait.
      const withCooldown = async <T>(
        run: () => Promise<T>,
        signal: AbortSignal,
        metadata = false,
      ): Promise<T> => {
        if (attempt !== generation)
          throw new MapsFailure("cancelled", "Maps connection changed.");
        signal.throwIfAborted();
        if (!metadata && cooldown && Date.now() < cooldown.until)
          throw cooldown.error;
        try {
          const value = await run();
          signal.throwIfAborted();
          if (attempt !== generation)
            throw new MapsFailure("cancelled", "Maps connection changed.");
          return value;
        } catch (error) {
          if (
            attempt === generation &&
            !signal.aborted &&
            (error as { status?: number })?.status === 429
          ) {
            const now = Date.now(),
              limit = serviceLimit(error, now);
            const wait =
              limit?.retryAfterMs ??
              (limit?.resetsAt != null ? limit.resetsAt - now : null);
            if (
              wait != null &&
              Number.isFinite(wait) &&
              wait > 0 &&
              wait <= MAX_PERIOD_RESET_MS
            )
              cooldown = {
                until: Math.max(cooldown?.until ?? 0, now + wait),
                error,
              };
          }
          throw error;
        }
      };
      const request: CloudMapsRequest = (route, signal, body) =>
        withCooldown(
          () => captured(route, signal, body),
          signal,
          route === "capabilities",
        );
      const meta = await call(request, "capabilities", signal);
      const caps = meta.capabilities as Record<string, unknown> | undefined;
      const regions = meta.regions;
      if (
        typeof meta.providerId !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(meta.providerId) ||
        typeof meta.connectionId !== "string" ||
        !/^conn_[A-Za-z0-9_-]{16,}$/.test(meta.connectionId) ||
        !boundedText(meta.revision, 100) ||
        !boundedText(meta.attribution, 2000) ||
        !Array.isArray(regions) ||
        regions.length < 1 ||
        regions.length > 64 ||
        !regions.every(
          (r) =>
            r &&
            typeof r === "object" &&
            boundedText(r.id, 64) &&
            boundedText(r.name, 100) &&
            validBounds(r.bounds),
        ) ||
        !caps ||
        caps.search !== true ||
        caps.placeDetails !== true ||
        (caps.traffic !== "none" && caps.traffic !== "live") ||
        (caps.transit !== "none" && caps.transit !== "scheduled") ||
        // Transit routes need the timetables the provider says it serves.
        (Array.isArray(caps.modes) &&
          caps.modes.includes("transit") &&
          caps.transit !== "scheduled") ||
        (caps.alternatives !== undefined &&
          typeof caps.alternatives !== "boolean") ||
        !Array.isArray(caps.modes) ||
        caps.modes.length < 1 ||
        !caps.modes.every((mode) => MODES.includes(mode))
      )
        throw new MapsFailure(
          "invalid-response",
          "Cloud Maps coverage is invalid.",
        );
      const alternatives = caps.alternatives === true;
      const sources = sourcesOf(meta.sources),
        disclosure = disclosureOf(meta.disclosure),
        tiles = caps.map === true ? tilesOf(meta.tiles) : undefined;
      const tilesRequest =
        tiles && options.tileRequest ? options.tileRequest() : undefined;
      tileFetch = tilesRequest
        ? (z, x, y, signal) =>
            withCooldown(() => tilesRequest(z, x, y, signal), signal)
        : undefined;
      coverage = Object.freeze({
        providerId: meta.providerId,
        revision: meta.revision as string,
        attribution: meta.attribution as string,
        regions: Object.freeze(
          regions.map((r) =>
            Object.freeze({
              id: r.id,
              name: r.name,
              bounds: Object.freeze([
                ...r.bounds,
              ]) as unknown as CloudMapsRegion["bounds"],
            }),
          ),
        ),
        ...(sources ? { sources } : {}),
        ...(disclosure ? { disclosure } : {}),
        ...(tiles ? { tiles } : {}),
      });
      viewportRequest = request;
      configure(
        {
          status: "configured",
          providerId: meta.providerId,
          connectionId: meta.connectionId,
          revision: meta.revision as string,
          capabilities: {
            // A map plane only when Cloud serves tiles and this host can fetch them.
            map: Boolean(tiles && tileFetch),
            search: true,
            placeDetails: true,
            modes: [...(caps.modes as TravelMode[])],
            traffic: caps.traffic as "none" | "live",
            transit: caps.transit === "scheduled" ? "scheduled" : "none",
            offline: { map: false, search: false, routing: false },
            alternatives,
          },
        },
        new CloudProvider(
          meta.providerId,
          meta.connectionId,
          request,
          alternatives,
        ),
      );
      installed = true;
    } catch (error) {
      if (attempt !== generation) return;
      coverage = undefined;
      tileFetch = undefined;
      viewportRequest = undefined;
      const refused = cloudMapsFailure(error, signal, serviceLimit, isOffline);
      diagnostic.error = refused.code;
      diagnostic.message = refused.message;
    }
  }
  return {
    initializeCloudMaps,
    retireCloudMaps: () => {
      ++generation;
      cooldown = undefined;
      coverage = undefined;
      tileFetch = undefined;
      viewportRequest = undefined;
      diagnostic.error = "unauthorized";
      diagnostic.message = "Sign in to Cloud to use Maps.";
      uninstall();
    },
    cloudMapsCoverage: () => coverage,
    /**
     * The Cloud raster basemap while Cloud serves tiles and the host passed
     * `tileRequest`. Google's terms require Google results on Google tiles, so
     * hosts draw this instead of their own basemap when it is present.
     */
    cloudMapsBasemap: (): CloudMapsBasemap | undefined => {
      const tiles = coverage?.tiles,
        fetchTile = tileFetch,
        send = viewportRequest,
        attempt = generation;
      if (!tiles || !fetchTile || !send) return undefined;
      return Object.freeze({
        kind: "cloud-raster" as const,
        attribution: tiles.attribution,
        minZoom: tiles.minZoom,
        maxZoom: tiles.maxZoom,
        tileSize: tiles.tileSize,
        tile: async (z: number, x: number, y: number, signal: AbortSignal) => {
          if (
            attempt !== generation ||
            !Number.isInteger(z) ||
            z < tiles.minZoom ||
            z > tiles.maxZoom ||
            !Number.isInteger(x) ||
            !Number.isInteger(y) ||
            x < 0 ||
            y < 0 ||
            x >= 2 ** z ||
            y >= 2 ** z
          )
            throw new MapsFailure(
              "unsupported",
              "This map tile is unavailable.",
            );
          try {
            return await fetchTile(z, x, y, signal);
          } catch (error) {
            throw cloudMapsFailure(error, signal, serviceLimit);
          }
        },
        copyright: async (view, signal) => {
          const result = await call(send, "tiles/viewport", signal, {
            zoom: Math.max(0, Math.min(22, Math.round(view.zoom))),
            north: view.north,
            south: view.south,
            east: view.east,
            west: view.west,
          });
          return boundedText(result.copyright, 500)
            ? (result.copyright as string)
            : tiles.attribution;
        },
      });
    },
    cloudMapsDiagnostics: () => ({ ...diagnostic }),
  };
}
