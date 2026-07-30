/**
 * Ticketmaster Discovery v2 adapter for local activity candidates.
 *
 * Discovery data is deliberately not promoted to eligibility, capacity,
 * waitlist acceptance, purchase, or childcare coverage; those states require
 * separate authoritative verification.
 */

import {
  type ActivitySourceStatus,
  type LocalActivity,
  type LocalActivityOraclePayload,
  type LocalActivityOracleQuery,
  type OracleIssue,
  type OraclePayload,
  type OracleProvenance,
  type OracleQuery,
  type OracleSnapshot,
  oracleError,
} from "./contracts.js";
import {
  freshnessFromHeaders,
  isRecord,
  isRfc3339Instant,
  readFiniteNumber,
  readString,
  requestBoundedJson,
  resolveFixedEndpoint,
} from "./http.js";

const TICKETMASTER_DISCOVERY_ORIGIN =
  "https://app.ticketmaster.com/discovery/v2/";
const TICKETMASTER_DEFAULT_TTL_MS = 10 * 60 * 1_000;
const MAX_PAGE_SIZE = 100;
const MAX_PAGES_PER_QUERY = 5;
const MIN_REQUEST_INTERVAL_MS = 200;

export interface TicketmasterDiscoveryAdapterOptions {
  apiKeyResolver: () => string | undefined;
  endpointOverride?: string;
  allowInsecureLoopbackForTests?: boolean;
  timeoutMs?: number;
  maxBodyBytes?: number;
  requestIntervalMs?: number;
}

export class TicketmasterDiscoveryAdapter {
  readonly kind = "local-activity" as const;
  readonly provider = "Ticketmaster Discovery API v2";
  private readonly endpoint: URL;
  private nextRequestAt = 0;

  constructor(private readonly options: TicketmasterDiscoveryAdapterOptions) {
    this.endpoint = resolveFixedEndpoint({
      production: TICKETMASTER_DISCOVERY_ORIGIN,
      override: options.endpointOverride,
      allowInsecureLoopbackForTests: options.allowInsecureLoopbackForTests,
    });
    if (
      options.requestIntervalMs !== undefined &&
      options.requestIntervalMs < MIN_REQUEST_INTERVAL_MS &&
      !options.allowInsecureLoopbackForTests
    ) {
      throw oracleError(
        "Production Ticketmaster requests may not exceed five per second.",
        "TICKETMASTER_RATE_CONFIG_INVALID",
      );
    }
  }

  async observe(
    query: OracleQuery,
    now = new Date(),
  ): Promise<OracleSnapshot<OraclePayload>> {
    if (query.kind !== "local-activity") {
      throw oracleError(
        "Activity adapter received an incompatible oracle query.",
        "ORACLE_QUERY_KIND_MISMATCH",
        { expected: "local-activity", received: query.kind },
      );
    }
    return this.discover(query, now);
  }

  async discover(
    query: LocalActivityOracleQuery,
    now = new Date(),
  ): Promise<OracleSnapshot<LocalActivityOraclePayload>> {
    validateActivityQuery(query);
    const apiKey = this.options.apiKeyResolver()?.trim();
    if (!apiKey) {
      throw oracleError(
        "Ticketmaster Discovery credential is not configured.",
        "TICKETMASTER_API_KEY_MISSING",
      );
    }

    const pageSize = query.pageSize ?? 50;
    const maxPages = query.maxPages ?? 2;
    const activities = new Map<string, LocalActivity>();
    const issues: OracleIssue[] = [];
    let pagesRead = 0;
    let totalPages = 1;
    let totalElementsReported: number | null = null;
    let lastHeaders = new Headers();

    while (pagesRead < Math.min(totalPages, maxPages)) {
      await this.waitForRateLimit();
      const url = buildSearchUrl({
        endpoint: this.endpoint,
        query,
        apiKey,
        page: pagesRead,
        pageSize,
      });
      const response = await requestBoundedJson({
        url,
        safeResource: "ticketmaster.com/discovery/events",
        headers: { Accept: "application/json" },
        timeoutMs: this.options.timeoutMs,
        maxBodyBytes: this.options.maxBodyBytes,
        sensitiveValues: [apiKey],
      });
      lastHeaders = response.headers;
      const page = parseSearchPage(response.body, now);
      pagesRead += 1;
      totalPages = page.totalPages;
      totalElementsReported = page.totalElements;
      for (const parsed of page.events) {
        if (parsed.issue) {
          issues.push(parsed.issue);
        }
        if (!parsed.activity) {
          continue;
        }
        if (activities.has(parsed.activity.sourceEventId)) {
          issues.push({
            code: "TICKETMASTER_DUPLICATE_EVENT",
            message: "A duplicate discovery event was ignored.",
            scope: parsed.activity.sourceEventId,
          });
          continue;
        }
        activities.set(parsed.activity.sourceEventId, parsed.activity);
      }
    }

    if (totalPages > maxPages) {
      issues.push({
        code: "TICKETMASTER_PAGING_TRUNCATED",
        message:
          "Discovery results exceeded the configured page budget; the observation is partial.",
        scope: "paging",
      });
    }
    const payload: LocalActivityOraclePayload = {
      kind: "local-activity",
      activities: [...activities.values()],
      pagesRead,
      totalElementsReported,
    };
    return {
      health: issues.length === 0 ? "complete" : "partial",
      value: payload,
      freshness: freshnessFromHeaders({
        headers: lastHeaders,
        observedAt: now,
        defaultTtlMs: TICKETMASTER_DEFAULT_TTL_MS,
      }),
      provenance: {
        provider: this.provider,
        resource: "Ticketmaster Discovery v2 event search",
        retrievedAt: now.toISOString(),
        coverage:
          "Ticketmaster-published discovery inventory in the requested market",
        contentTrust: "untrusted-source-data",
      },
      issues,
    };
  }

  private async waitForRateLimit(): Promise<void> {
    const interval = this.options.requestIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
    if (!Number.isSafeInteger(interval) || interval < 0) {
      throw oracleError(
        "Ticketmaster request interval must be a non-negative integer.",
        "TICKETMASTER_RATE_CONFIG_INVALID",
      );
    }
    const waitMs = Math.max(0, this.nextRequestAt - Date.now());
    if (waitMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
    this.nextRequestAt = Date.now() + interval;
  }
}

function validateActivityQuery(query: LocalActivityOracleQuery): void {
  if (
    !isRfc3339Instant(query.startAt) ||
    !isRfc3339Instant(query.endAt) ||
    Date.parse(query.endAt) <= Date.parse(query.startAt)
  ) {
    throw oracleError(
      "Activity discovery requires a valid increasing time range.",
      "TICKETMASTER_TIME_RANGE_INVALID",
    );
  }
  const pageSize = query.pageSize ?? 50;
  const maxPages = query.maxPages ?? 2;
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0 ||
    pageSize > MAX_PAGE_SIZE ||
    !Number.isSafeInteger(maxPages) ||
    maxPages <= 0 ||
    maxPages > MAX_PAGES_PER_QUERY ||
    pageSize * maxPages >= 1_000
  ) {
    throw oracleError(
      "Activity discovery paging exceeds the bounded API policy.",
      "TICKETMASTER_PAGING_INVALID",
      { maxPageSize: MAX_PAGE_SIZE, maxPages: MAX_PAGES_PER_QUERY },
    );
  }
  if (
    query.keywords.some(
      (keyword) => keyword.trim().length === 0 || keyword.length > 100,
    )
  ) {
    throw oracleError(
      "Activity discovery keywords are empty or too long.",
      "TICKETMASTER_KEYWORD_INVALID",
    );
  }

  if (query.location.kind === "postal-code") {
    if (
      query.location.postalCode.trim().length === 0 ||
      !/^[A-Za-z]{2}$/.test(query.location.countryCode)
    ) {
      throw oracleError(
        "Activity postal location is invalid.",
        "TICKETMASTER_LOCATION_INVALID",
      );
    }
    return;
  }
  if (
    !Number.isFinite(query.location.latitude) ||
    query.location.latitude < -90 ||
    query.location.latitude > 90 ||
    !Number.isFinite(query.location.longitude) ||
    query.location.longitude < -180 ||
    query.location.longitude > 180 ||
    !Number.isFinite(query.location.radius) ||
    query.location.radius <= 0 ||
    query.location.radius > 500
  ) {
    throw oracleError(
      "Activity coordinate location is invalid.",
      "TICKETMASTER_LOCATION_INVALID",
    );
  }
}

function buildSearchUrl(args: {
  endpoint: URL;
  query: LocalActivityOracleQuery;
  apiKey: string;
  page: number;
  pageSize: number;
}): URL {
  const url = new URL("events.json", args.endpoint);
  url.searchParams.set("apikey", args.apiKey);
  url.searchParams.set(
    "startDateTime",
    new Date(args.query.startAt).toISOString(),
  );
  url.searchParams.set("endDateTime", new Date(args.query.endAt).toISOString());
  url.searchParams.set("includeTBA", "no");
  url.searchParams.set("includeTBD", "no");
  url.searchParams.set("includeTest", "no");
  url.searchParams.set("size", String(args.pageSize));
  url.searchParams.set("page", String(args.page));
  url.searchParams.set("sort", "date,asc");
  if (args.query.keywords.length > 0) {
    url.searchParams.set(
      "keyword",
      args.query.keywords.map((keyword) => keyword.trim()).join(" "),
    );
  }
  if (args.query.location.kind === "postal-code") {
    url.searchParams.set("postalCode", args.query.location.postalCode.trim());
    url.searchParams.set(
      "countryCode",
      args.query.location.countryCode.toUpperCase(),
    );
  } else {
    url.searchParams.set(
      "geoPoint",
      encodeGeohash(
        args.query.location.latitude,
        args.query.location.longitude,
      ),
    );
    url.searchParams.set("radius", String(args.query.location.radius));
    url.searchParams.set("unit", args.query.location.unit);
  }
  return url;
}

function encodeGeohash(
  latitude: number,
  longitude: number,
  precision = 9,
): string {
  const alphabet = "0123456789bcdefghjkmnpqrstuvwxyz";
  const latitudeRange: [number, number] = [-90, 90];
  const longitudeRange: [number, number] = [-180, 180];
  let bits = 0;
  let value = 0;
  let useLongitude = true;
  let output = "";
  while (output.length < precision) {
    const range = useLongitude ? longitudeRange : latitudeRange;
    const coordinate = useLongitude ? longitude : latitude;
    const midpoint = (range[0] + range[1]) / 2;
    value = (value << 1) | (coordinate >= midpoint ? 1 : 0);
    if (coordinate >= midpoint) {
      range[0] = midpoint;
    } else {
      range[1] = midpoint;
    }
    useLongitude = !useLongitude;
    bits += 1;
    if (bits === 5) {
      output += alphabet.charAt(value);
      bits = 0;
      value = 0;
    }
  }
  return output;
}

function parseSearchPage(
  body: unknown,
  now: Date,
): {
  events: Array<
    | { activity: LocalActivity; issue: OracleIssue | null }
    | { activity: null; issue: OracleIssue }
  >;
  totalPages: number;
  totalElements: number | null;
} {
  if (!isRecord(body)) {
    throw oracleError(
      "Ticketmaster response was not an object.",
      "TICKETMASTER_RESPONSE_INVALID",
    );
  }
  const page = isRecord(body.page) ? body.page : null;
  const totalPagesValue = page ? readFiniteNumber(page, "totalPages") : null;
  const totalElementsValue = page
    ? readFiniteNumber(page, "totalElements")
    : null;
  if (
    totalPagesValue === null ||
    !Number.isSafeInteger(totalPagesValue) ||
    totalPagesValue < 0 ||
    (totalElementsValue !== null &&
      (!Number.isSafeInteger(totalElementsValue) || totalElementsValue < 0))
  ) {
    throw oracleError(
      "Ticketmaster response omitted valid paging metadata.",
      "TICKETMASTER_RESPONSE_INVALID",
    );
  }

  const embedded = isRecord(body._embedded) ? body._embedded : null;
  const rawEvents = embedded?.events;
  if (rawEvents === undefined && totalElementsValue === 0) {
    return {
      events: [],
      totalPages: totalPagesValue,
      totalElements: totalElementsValue,
    };
  }
  if (!Array.isArray(rawEvents)) {
    throw oracleError(
      "Ticketmaster response omitted its event array.",
      "TICKETMASTER_RESPONSE_INVALID",
    );
  }
  return {
    events: rawEvents.map((event, index) => parseEvent(event, index, now)),
    totalPages: totalPagesValue,
    totalElements: totalElementsValue,
  };
}

function parseEvent(
  value: unknown,
  index: number,
  now: Date,
):
  | { activity: LocalActivity; issue: OracleIssue | null }
  | { activity: null; issue: OracleIssue } {
  if (!isRecord(value)) {
    return malformedEvent(index);
  }
  const id = readString(value, "id");
  const title = readString(value, "name");
  const registrationUrl = readString(value, "url");
  if (!id || !title || !registrationUrl || !isHttpUrl(registrationUrl)) {
    return malformedEvent(index);
  }

  const dates = isRecord(value.dates) ? value.dates : null;
  const start = dates && isRecord(dates.start) ? dates.start : null;
  const end = dates && isRecord(dates.end) ? dates.end : null;
  const status =
    dates && isRecord(dates.status)
      ? normalizeSourceStatus(readString(dates.status, "code"))
      : "unknown";
  const venue = firstVenue(value);
  const startAt = readIsoInstant(start, "dateTime");
  const endAt = readIsoInstant(end, "dateTime");
  const timeZone = dates ? readString(dates, "timezone") : null;
  const incomplete =
    !startAt ||
    !timeZone ||
    (!venue.name && !venue.address) ||
    status === "unknown";
  const provenance: OracleProvenance = {
    provider: "Ticketmaster Discovery API v2",
    resource: `Ticketmaster event ${id}`,
    retrievedAt: now.toISOString(),
    coverage: "Discovery metadata only; not eligibility or inventory proof",
    contentTrust: "untrusted-source-data",
  };
  return {
    activity: {
      source: "ticketmaster",
      sourceEventId: id,
      title,
      startAt,
      endAt,
      timeZone,
      venue,
      registrationUrl,
      sourceStatus: status,
      eligibility: { state: "unknown" },
      accessibility: { state: "unknown" },
      capacity: { state: "unknown" },
      purchase: { state: "unknown" },
      childcareCoverage: "not-counted",
      provenance,
    },
    issue: incomplete
      ? {
          code: "TICKETMASTER_EVENT_PARTIAL",
          message:
            "A discovery event omitted authoritative time, venue, or status metadata.",
          scope: id,
        }
      : null,
  };
}

function malformedEvent(index: number): {
  activity: null;
  issue: OracleIssue;
} {
  return {
    activity: null,
    issue: {
      code: "TICKETMASTER_EVENT_INVALID",
      message: "A malformed discovery event was excluded.",
      scope: `event:${index}`,
    },
  };
}

function firstVenue(value: Record<string, unknown>): LocalActivity["venue"] {
  const embedded = isRecord(value._embedded) ? value._embedded : null;
  const venues = embedded?.venues;
  const venue = Array.isArray(venues) && isRecord(venues[0]) ? venues[0] : null;
  if (!venue) {
    return {
      name: null,
      address: null,
      latitude: null,
      longitude: null,
    };
  }
  const address = isRecord(venue.address)
    ? readString(venue.address, "line1")
    : null;
  const city = isRecord(venue.city) ? readString(venue.city, "name") : null;
  const state = isRecord(venue.state)
    ? (readString(venue.state, "stateCode") ?? readString(venue.state, "name"))
    : null;
  const postalCode = readString(venue, "postalCode");
  const location = isRecord(venue.location) ? venue.location : null;
  return {
    name: readString(venue, "name"),
    address:
      [address, city, state, postalCode].filter(Boolean).join(", ") || null,
    latitude: location ? coordinateValue(location, "latitude") : null,
    longitude: location ? coordinateValue(location, "longitude") : null,
  };
}

function coordinateValue(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readIsoInstant(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!record) return null;
  const value = readString(record, key);
  return value && isRfc3339Instant(value)
    ? new Date(value).toISOString()
    : null;
}

function normalizeSourceStatus(value: string | null): ActivitySourceStatus {
  switch (value?.toLowerCase()) {
    case "onsale":
      return "onsale";
    case "offsale":
      return "offsale";
    case "canceled":
      return "canceled";
    case "postponed":
      return "postponed";
    case "rescheduled":
      return "rescheduled";
    default:
      return "unknown";
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    // error-policy:J3 Ticket links are untrusted provider input; invalid URLs
    // produce an explicit invalid event rather than a fake registration link.
    return false;
  }
}
