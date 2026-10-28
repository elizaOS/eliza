/** Existing producer evidence validators for the default-off typed read adapter; no transport dispatch. */

import { hashStableJson } from "@elizaos/core";
import { stableStringify } from "@elizaos/core/protocol";
import type { WebFetchOriginRead } from "@elizaos/plugin-coding-tools/edge";
import type { SharedTurnMessage } from "./run-shared-agent-turn";
import { parseExplicitUsWeatherQuery, weatherDistanceKm } from "./shared-current-weather";
import {
  newsPublicationScope,
  publicationScopedNewsQuery,
  type SharedNewsPublicationScope,
} from "./shared-news-publication";
import {
  isSharedPublicSearchSafe,
  normalizedRealtimeQuery,
  resolveSharedRealtimeRequirement,
  type SharedRealtimeRequirement,
} from "./shared-realtime-grounding";
import {
  resolveWorldWeatherScope,
  weatherLocationWithoutTemperatureUnit,
} from "./shared-world-weather";

export interface SharedPublicSearchPart {
  message: string;
  requirement: SharedRealtimeRequirement & { publicationScope?: SharedNewsPublicationScope };
}

/** Bind positional obligations to their original physical request, not a stale same-index topic. */
export function typedReadRequirementId(part: SharedPublicSearchPart, index: number): string {
  return `public-read:${index}:${hashStableJson({ message: part.message, domain: part.requirement.domain, query: part.requirement.query })}`;
}

/** The current public query matcher remains exact; typed replies grant no broader search scope. */
export function sharedNewsSearchMatchesRequest(
  query: string,
  requirement: SharedPublicSearchPart["requirement"],
): boolean {
  return (
    isSharedPublicSearchSafe(query) &&
    normalizedRealtimeQuery(query) === normalizedRealtimeQuery(requirement.query)
  );
}

/** Only the complete authenticated utterance may introduce public obligations. */
export function resolveTypedPublicReadParts(
  message: string,
  history: readonly SharedTurnMessage[] = [],
  nowMs = Date.now(),
): SharedPublicSearchPart[] | undefined {
  if (!isSharedPublicSearchSafe(message)) return undefined;
  const clauses = message
    .split(
      /\s*;\s*|\s*,?\s+and\s+(?=(?:(?:what['’]?s|what\s+is|give\s+me|show\s+me|tell\s+me)\s+)?(?:(?:one|a|an|the)\s+)?(?:weather|forecast|temperature|(?:(?:latest|current|breaking)\s+)?[^;?!\n]{0,60}?\b(?:news|headlines?)))/iu,
    )
    .map((value) => value.trim())
    .filter(Boolean);
  if (clauses.length > 2) return undefined;
  const parts: SharedPublicSearchPart[] = [];
  for (const clause of clauses) {
    // Attribution instructions remain in part.message/source-link policy, not in a physical place query.
    const evidenceMessage = typedTemperatureEvidenceMessage(clause);
    const requirement = resolveSharedRealtimeRequirement(
      evidenceMessage,
      clauses.length === 1 ? history : [],
    );
    if (!requirement || (requirement.domain !== "weather" && requirement.domain !== "news"))
      return undefined;
    parts.push({
      message: clause,
      requirement: {
        ...requirement,
        ...(requirement.domain === "news"
          ? {
              publicationScope: newsPublicationScope(
                publicationScopedNewsQuery(
                  requirement.query.match(/^latest public (?:(.+) )?news$/iu)?.[1],
                  clause,
                  nowMs,
                ),
                nowMs,
              ),
            }
          : {}),
      },
    });
  }
  return parts.length ? parts : undefined;
}

/** Current raw utterance only; an explicit refusal overrides a request elsewhere in the turn. */
export function sharedReplyWantsSourceLinks(message: string): boolean {
  if (
    /\b(?:no|without|omit|skip)\s+(?:any\s+)?(?:links?|sources?|urls?|citations?)\b|\b(?:don[’']?t|do not)\s+(?:include|show|add|give|send|cite)\b[^.!?]{0,40}\b(?:links?|sources?|urls?|citations?)\b/iu.test(
      message,
    )
  )
    return false;
  return /\b(?:with|include|show|give|add|provide|send|attach)\b[^.!?]{0,512}\b(?:links?|sources?|urls?|citations?)\b|\b(?:cite|citations?)\b|\b(?:sources?|links?|urls?)\s*[?!.]*$/iu.test(
    message,
  );
}

/** Strip only complete attribution instructions; the original request still owns query and source-link policy. */
export function typedTemperatureEvidenceMessage(message: string): string {
  return message
    .replace(
      /(?:[,.!?;]\s*|\s+(?:and\s+)?)(?:please\s+)?(?:include|show|give|add|provide|send|attach|with)\s+(?:(?:me|a|an|one|the)\s+)*(?:sources?|links?|urls?|citations?)(?:\s+links?)?\s*[.!?]*\s*$/iu,
      "",
    )
    .replace(/(?:[,.!?;]\s*|\s+)(?:sources?|links?|urls?|citations?)\s*[?!.]*\s*$/iu, "")
    .trim();
}

/** A single current temperature can retain its producer's actual unit when the user requests none. */
export function isSimpleCurrentTemperatureRequest(message: string): boolean {
  if (!isSharedPublicSearchSafe(message)) return false;
  const request = typedTemperatureEvidenceMessage(message);
  const questions = request
    .split(/[!?]/u)
    .map((part) => part.trim().replace(/[.]+$/u, ""))
    .filter(Boolean);
  const substantive = questions.filter(
    (part) => !/^(?:in\s+)?(?:Celsius|°\s*C)\s*[.]*$/iu.test(part),
  );
  return (
    substantive.length === 1 &&
    (request.match(/\btemperature\b/giu)?.length ?? 0) === 1 &&
    /\b(?:current|now|rn)\b/iu.test(request) &&
    !/\b(?:and|also|plus|with|as\s+well)\b/iu.test(request) &&
    !/\b(?:weather|forecast|tomorrow|tonight|weekend|hourly|later|wind|rain|snow|precipitation|humidity|conditions|feels|high|low|fahrenheit|kelvin)\b|°\s*[FK]\b/iu.test(
      request,
    )
  );
}

/** Preserve the existing explicit-Celsius eligibility signal for source-specific callers. */
export function isSimpleCurrentCelsiusTemperature(message: string): boolean {
  return isSimpleCurrentTemperatureRequest(message) && /\bCelsius\b|°\s*C\b/iu.test(message);
}

export const WTTR_CURRENT_OBSERVATION_AGE_MS = 3600000;

export type SharedCurrentWttrAuthority =
  | {
      status: "available";
      current: { temperatureC: number; place: string; sourceUrl: string; observedAtMs: number };
      observationAgeSeconds: number;
      observationTimeBasis: "provider-local-date" | "server-derived-for-validation";
    }
  | {
      status: "unavailable";
      reason:
        | "receipt_invalid"
        | "observation_stale"
        | "observation_future"
        | "observation_time_unverified";
      observationAgeSeconds?: number;
      observationTimeBasis?: "provider-local-date" | "server-derived-for-validation";
    };

const EXPLICIT_WEATHER_POINT =
  /\b(?:gps|coordinates?|latitude|longitude|station|sensor)\b|[-+]?\d+(?:\.\d+)?\s*,\s*[-+]?\d+(?:\.\d+)?/iu;

/** A nearby provider report is distinct from verified current weather. */
export interface SharedLatestWeatherReport {
  kind: "latest_weather_report";
  query: string;
  targetPlace: string;
  providerLocality: string;
  country: string;
  temperatureC: number;
  reportedClock: string;
  reportedDate: string | null;
  reportedDateStatus: "provided" | "unknown";
  reportedTimeZone: null;
  reportedTimeZoneStatus: "unknown";
  sourceUrl: string;
  requestedAt: number;
  retrievedAt: number;
  /** Distance from the provider's named area to the catalog city, not a sensor offset. */
  distanceToTargetKm: number;
  evidence: {
    success: true;
    action: "WEB_FETCH";
    url: string;
    finalUrl: string;
    status: 200;
    kind: "json";
    truncated: false;
    contentType: string;
    originRead: WebFetchOriginRead;
    requestEcho: { type: "LatLon"; query: string } | null;
  };
}

/** Retain a named-city report without inferring its observation instant or currentness. */
export function readSharedLatestWeatherReport(
  result: unknown,
  query: string,
  now = Date.now(),
): SharedLatestWeatherReport | undefined {
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !isSharedPublicSearchSafe(query) ||
    EXPLICIT_WEATHER_POINT.test(query)
  )
    return undefined;
  const record = object(result),
    data = object(record?.data),
    read = object(data?.originRead),
    wttr = object(read?.wttr),
    area = object(wttr?.nearestArea),
    condition = object(wttr?.currentCondition);
  const scope = resolveWorldWeatherScope(typedTemperatureEvidenceMessage(query), now);
  if (
    !record ||
    record.success !== true ||
    !data ||
    data.action !== "WEB_FETCH" ||
    data.provider !== undefined ||
    data.status !== 200 ||
    data.kind !== "json" ||
    data.truncated !== false ||
    !read ||
    !area ||
    !condition ||
    !scope ||
    scope.kind !== "current" ||
    read.format !== "elizaos.web-fetch.origin.v1" ||
    read.status !== 200 ||
    read.cache !== "no-store" ||
    read.redirect !== "manual" ||
    !Number.isSafeInteger(read.requestedAt) ||
    !Number.isSafeInteger(read.retrievedAt) ||
    Number(read.requestedAt) < 0 ||
    Number(read.retrievedAt) < Number(read.requestedAt) ||
    Number(read.retrievedAt) - Number(read.requestedAt) > 15000 ||
    Number(read.retrievedAt) > now ||
    now - Number(read.retrievedAt) > 300000 ||
    typeof read.url !== "string" ||
    read.url.length > 2048 ||
    read.url !== data.url ||
    data.url !== data.final_url ||
    typeof read.contentType !== "string" ||
    read.contentType.length > 256 ||
    read.contentType !== data.content_type ||
    !/^(?:application\/(?:[\w.+-]+\+)?json|text\/plain)(?:;|$)/iu.test(read.contentType) ||
    (data.query !== undefined && data.query !== query) ||
    (object(data.currentWeatherAuthority)?.query !== undefined &&
      object(data.currentWeatherAuthority)?.query !== query)
  )
    return undefined;
  let url: URL;
  try {
    url = new URL(read.url);
  } catch {
    return undefined;
  }
  const coordinates = url.pathname.match(/^\/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/u);
  const latitude = Number(coordinates?.[1]),
    longitude = Number(coordinates?.[2]);
  if (
    url.origin !== "https://wttr.in" ||
    url.username ||
    url.password ||
    url.hash ||
    !coordinates ||
    [...url.searchParams].length !== 1 ||
    url.searchParams.get("format") !== "j1" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    weatherDistanceKm(scope.place.latitude, scope.place.longitude, latitude, longitude) > 10
  )
    return undefined;
  const name = area.name,
    country = area.country,
    areaLatitude = area.latitude,
    areaLongitude = area.longitude,
    temperature = condition.temperatureC,
    reportedClock = condition.observationTime;
  if (
    typeof name !== "string" ||
    !/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'’()&-]{0,127}$/u.test(name) ||
    typeof country !== "string" ||
    country.length > 128 ||
    typeof areaLatitude !== "string" ||
    typeof areaLongitude !== "string" ||
    areaLatitude.length > 128 ||
    areaLongitude.length > 128 ||
    !/^-?\d+(?:\.\d+)?$/u.test(areaLatitude) ||
    !/^-?\d+(?:\.\d+)?$/u.test(areaLongitude) ||
    !Number.isFinite(Number(areaLatitude)) ||
    !Number.isFinite(Number(areaLongitude)) ||
    Math.abs(Number(areaLatitude)) > 90 ||
    Math.abs(Number(areaLongitude)) > 180 ||
    typeof temperature !== "string" ||
    temperature.length > 128 ||
    !/^-?(?:0|[1-9]\d{0,2})(?:\.\d+)?$/u.test(temperature) ||
    Number(temperature) < -100 ||
    Number(temperature) > 70 ||
    typeof reportedClock !== "string" ||
    !/^(?:0?[1-9]|1[0-2]):[0-5]\d (?:AM|PM)$/u.test(reportedClock)
  )
    return undefined;
  const fold = (value: string) =>
    value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
  const distanceToTargetKm = weatherDistanceKm(
    scope.place.latitude,
    scope.place.longitude,
    Number(areaLatitude),
    Number(areaLongitude),
  );
  if (
    ![scope.place.country, scope.place.countryCode].some(
      (value) => fold(value) === fold(country),
    ) ||
    distanceToTargetKm > 10
  )
    return undefined;
  let reportedDate: string | null = null;
  if (condition.localObservationTime !== undefined) {
    if (
      typeof condition.localObservationTime !== "string" ||
      !/^\d{4}-\d{2}-\d{2} (?:0?[1-9]|1[0-2]):[0-5]\d (?:AM|PM)$/u.test(
        condition.localObservationTime,
      ) ||
      condition.observationDateBasis !== "provider-local-date"
    )
      return undefined;
    reportedDate = condition.localObservationTime.slice(0, 10);
    const calendar = new Date(`${reportedDate}T00:00:00Z`);
    const currentDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: scope.place.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now + 60000);
    if (
      !Number.isFinite(calendar.getTime()) ||
      calendar.toISOString().slice(0, 10) !== reportedDate ||
      reportedDate > currentDay
    )
      return undefined;
    const datedInstant = datedWttrObservationInstant(
      condition.localObservationTime,
      reportedClock,
      Number(read.retrievedAt),
      scope.place.timeZone,
    );
    if (datedInstant === undefined || datedInstant > now + 120000) return undefined;
  } else if (condition.observationDateBasis !== "server-derived-for-validation") {
    return undefined;
  }
  let requestEcho: SharedLatestWeatherReport["evidence"]["requestEcho"] = null;
  if (typeof record.text === "string") {
    let body: Record<string, unknown> | undefined;
    try {
      body = object(JSON.parse(record.text));
    } catch {
      // A narrowed JSON extraction may omit the request echo; never manufacture one.
    }
    if (body?.request !== undefined) {
      const entries = body.request;
      const echo = Array.isArray(entries) && entries.length === 1 ? object(entries[0]) : undefined;
      const point =
        typeof echo?.query === "string" && echo.query.length <= 128
          ? echo.query.match(/^Lat (-?\d+(?:\.\d+)?) and Lon (-?\d+(?:\.\d+)?)$/u)
          : undefined;
      if (
        !echo ||
        echo.type !== "LatLon" ||
        !point ||
        !Number.isFinite(Number(point[1])) ||
        !Number.isFinite(Number(point[2])) ||
        Math.abs(Number(point[1])) > 90 ||
        Math.abs(Number(point[2])) > 180 ||
        weatherDistanceKm(
          scope.place.latitude,
          scope.place.longitude,
          Number(point[1]),
          Number(point[2]),
        ) > 10
      )
        return undefined;
      requestEcho = { type: "LatLon", query: String(echo.query) };
    }
  }
  const originRead: WebFetchOriginRead = {
    format: "elizaos.web-fetch.origin.v1",
    requestedAt: Number(read.requestedAt),
    retrievedAt: Number(read.retrievedAt),
    url: read.url,
    status: 200,
    contentType: read.contentType,
    cache: "no-store",
    redirect: "manual",
    wttr: {
      nearestArea: { name, country, latitude: areaLatitude, longitude: areaLongitude },
      currentCondition: {
        temperatureC: temperature,
        observationTime: reportedClock,
        observationDateBasis:
          reportedDate === null ? "server-derived-for-validation" : "provider-local-date",
        ...(reportedDate === null
          ? {}
          : { localObservationTime: String(condition.localObservationTime) }),
      },
    },
  };
  return {
    kind: "latest_weather_report",
    query,
    targetPlace: scope.place.name,
    providerLocality: name,
    country,
    temperatureC: Number(temperature),
    reportedClock,
    reportedDate,
    reportedDateStatus: reportedDate === null ? "unknown" : "provided",
    reportedTimeZone: null,
    reportedTimeZoneStatus: "unknown",
    sourceUrl: url.href,
    requestedAt: Number(read.requestedAt),
    retrievedAt: Number(read.retrievedAt),
    distanceToTargetKm,
    evidence: {
      success: true,
      action: "WEB_FETCH",
      url: String(data.url),
      finalUrl: String(data.final_url),
      status: 200,
      kind: "json",
      truncated: false,
      contentType: read.contentType,
      originRead,
      requestEcho,
    },
  };
}

/** Display a nearby report without claiming it is a verified current temperature. */
export function renderSharedLatestWeatherReport(
  report: SharedLatestWeatherReport,
  includeSourceLinks = false,
): string {
  return `A nearby report for ${report.providerLocality} says ${report.temperatureC}°C; I can’t confirm how recent it is.${includeSourceLinks ? `\n\nSource: ${report.sourceUrl}` : ""}`;
}

/** Recompute a persisted report from bounded public evidence; never promote it to current authority. */
export function parseSharedLatestWeatherReport(
  value: unknown,
  query: string,
  observedAt: number,
): SharedLatestWeatherReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const report = value as Record<string, unknown>;
  if (
    report.kind !== "latest_weather_report" ||
    report.query !== query ||
    !report.evidence ||
    typeof report.evidence !== "object" ||
    Array.isArray(report.evidence)
  )
    return undefined;
  const evidence = report.evidence as Record<string, unknown>;
  const projected = readSharedLatestWeatherReport(
    {
      success: evidence.success,
      data: {
        action: evidence.action,
        url: evidence.url,
        final_url: evidence.finalUrl,
        status: evidence.status,
        kind: evidence.kind,
        truncated: evidence.truncated,
        content_type: evidence.contentType,
        originRead: evidence.originRead,
      },
      ...(evidence.requestEcho === null
        ? {}
        : { text: stableStringify({ request: [evidence.requestEcho] }) }),
    },
    query,
    observedAt,
  );
  return projected && stableStringify(projected) === stableStringify(value) ? projected : undefined;
}

/** Stable temperature projection of the same diagnostic authority validator. */
export function currentWttrOriginTemperature(
  value: unknown,
  query: string,
  now = Date.now(),
  requireFresh = true,
): { temperatureC: number; place: string; sourceUrl: string } | undefined {
  const authority = inspectCurrentWttrOriginTemperature(value, query, now, requireFresh);
  return authority.status === "available" ? authority.current : undefined;
}

function datedWttrObservationInstant(
  localObservationTime: string,
  observationTime: string,
  retrievedAt: number,
  timeZone: string,
): number | undefined {
  const local = localObservationTime.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2}) (AM|PM)$/u);
  const utc = observationTime.match(/^(\d{1,2}):(\d{2}) (AM|PM)$/u);
  if (
    !local ||
    Number(local[4]) < 1 ||
    Number(local[4]) > 12 ||
    Number(local[5]) > 59 ||
    !utc ||
    Number(utc[1]) < 1 ||
    Number(utc[1]) > 12 ||
    Number(utc[2]) > 59
  )
    return undefined;
  const hour = (h: string, period: string) => (Number(h) % 12) + (period === "PM" ? 12 : 0);
  const day = Math.floor(retrievedAt / 86400000) * 86400000;
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  // Accept an instant only when the dated local observation and reported clock agree
  // under the named place's IANA zone. A bare clock never establishes a date or zone.
  const candidates = [-86400000, 0, 86400000]
    .map((offset) => day + offset + hour(utc[1]!, utc[3]!) * 3600000 + Number(utc[2]) * 60000)
    .filter((time) => {
      const parts = Object.fromEntries(
        format.formatToParts(time).map((part) => [part.type, part.value]),
      );
      return (
        parts.year === local[1] &&
        parts.month === local[2] &&
        parts.day === local[3] &&
        Number(parts.hour) === hour(local[4]!, local[6]!) &&
        Number(parts.minute) === Number(local[5])
      );
    });
  if (candidates.length !== 1) return undefined;
  return candidates[0];
}

/** Validate canonical Wttr origin facts without upgrading fetch time into observation time. */
export function inspectCurrentWttrOriginTemperature(
  value: unknown,
  query: string,
  now = Date.now(),
  requireFresh = true,
): SharedCurrentWttrAuthority {
  const object = (v: unknown): Record<string, unknown> | undefined =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  const read = object(value),
    wttr = object(read?.wttr),
    area = object(wttr?.nearestArea),
    condition = object(wttr?.currentCondition);
  const scope = resolveWorldWeatherScope(
    query,
    typeof read?.requestedAt === "number" ? read.requestedAt : now,
  );
  if (
    !read ||
    !area ||
    !condition ||
    !scope ||
    scope.kind !== "current" ||
    read.format !== "elizaos.web-fetch.origin.v1" ||
    !Number.isSafeInteger(read.requestedAt) ||
    !Number.isSafeInteger(read.retrievedAt) ||
    Number(read.requestedAt) < 0 ||
    Number(read.retrievedAt) < Number(read.requestedAt) ||
    Number(read.retrievedAt) - Number(read.requestedAt) > 15000 ||
    Number(read.retrievedAt) > now + 60000 ||
    (requireFresh && Math.abs(now - Number(read.retrievedAt)) > 300000) ||
    read.status !== 200 ||
    read.cache !== "no-store" ||
    read.redirect !== "manual" ||
    typeof read.url !== "string" ||
    read.url.length > 2048 ||
    typeof read.contentType !== "string" ||
    read.contentType.length > 256 ||
    !/^(?:application\/(?:[\w.+-]+\+)?json|text\/plain)(?:;|$)/iu.test(read.contentType)
  )
    return { status: "unavailable", reason: "receipt_invalid" };
  let url: URL;
  try {
    url = new URL(read.url);
  } catch {
    // error-policy:J3 An invalid source URL has no weather authority.
    return { status: "unavailable", reason: "receipt_invalid" };
  }
  const coordinates = url.pathname.match(/^\/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/u);
  const requestedLatitude = Number(coordinates?.[1]);
  const requestedLongitude = Number(coordinates?.[2]);
  if (
    url.origin !== "https://wttr.in" ||
    url.username ||
    url.password ||
    url.hash ||
    !coordinates ||
    [...url.searchParams].length !== 1 ||
    url.searchParams.get("format") !== "j1" ||
    !Number.isFinite(requestedLatitude) ||
    !Number.isFinite(requestedLongitude) ||
    Math.abs(requestedLatitude) > 90 ||
    Math.abs(requestedLongitude) > 180 ||
    weatherDistanceKm(
      scope.place.latitude,
      scope.place.longitude,
      requestedLatitude,
      requestedLongitude,
    ) > 10
  )
    return { status: "unavailable", reason: "receipt_invalid" };
  const literals = [
    area.name,
    area.country,
    area.latitude,
    area.longitude,
    condition.temperatureC,
    condition.observationTime,
  ];
  if (!literals.every((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 128))
    return { status: "unavailable", reason: "receipt_invalid" };
  const fold = (v: string) => v.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
  const latitude = Number(area.latitude),
    longitude = Number(area.longitude);
  if (
    ![scope.place.country, scope.place.countryCode].some(
      (country) => fold(country) === fold(String(area.country)),
    ) ||
    !/^-?\d+(?:\.\d+)?$/u.test(String(area.latitude)) ||
    !/^-?\d+(?:\.\d+)?$/u.test(String(area.longitude)) ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    // An origin may name a city neighborhood rather than the catalog city.
    // Both points stay local to that city, and the station must match the requested point.
    weatherDistanceKm(scope.place.latitude, scope.place.longitude, latitude, longitude) > 10 ||
    weatherDistanceKm(requestedLatitude, requestedLongitude, latitude, longitude) > 2
  )
    return { status: "unavailable", reason: "receipt_invalid" };
  const temperature = String(condition.temperatureC);
  if (
    !/^-?(?:0|[1-9]\d{0,2})(?:\.\d+)?$/u.test(temperature) ||
    Number(temperature) < -100 ||
    Number(temperature) > 70
  )
    return { status: "unavailable", reason: "receipt_invalid" };
  if (condition.localObservationTime === undefined)
    return { status: "unavailable", reason: "observation_time_unverified" };
  if (
    condition.observationDateBasis !== "provider-local-date" ||
    typeof condition.localObservationTime !== "string" ||
    condition.localObservationTime.length > 128
  )
    return { status: "unavailable", reason: "receipt_invalid" };
  const retrievedAt = Number(read.retrievedAt);
  const observedAt = datedWttrObservationInstant(
    condition.localObservationTime,
    String(condition.observationTime),
    retrievedAt,
    scope.place.timeZone,
  );
  if (observedAt === undefined) return { status: "unavailable", reason: "receipt_invalid" };
  if (
    observedAt < retrievedAt - WTTR_CURRENT_OBSERVATION_AGE_MS ||
    (requireFresh && observedAt < now - WTTR_CURRENT_OBSERVATION_AGE_MS)
  )
    return {
      status: "unavailable",
      reason: "observation_stale",
      observationAgeSeconds: (now - observedAt) / 1000,
      observationTimeBasis: "provider-local-date",
    };
  if (observedAt > retrievedAt + 120000 || (requireFresh && observedAt > now + 120000))
    return {
      status: "unavailable",
      reason: "observation_future",
      observationAgeSeconds: (now - observedAt) / 1000,
      observationTimeBasis: "provider-local-date",
    };
  return {
    status: "available",
    current: {
      temperatureC: Number(temperature),
      place: scope.place.name,
      sourceUrl: url.href,
      observedAtMs: observedAt,
    },
    observationAgeSeconds: (now - observedAt) / 1000,
    observationTimeBasis: "provider-local-date",
  };
}

/** Existing receipt validation owns the place, current time, exact Celsius value and source URL. */

export interface TypedNwsReadScope {
  requestedQuery: string;
  producerQuery: string;
  namedPlaceAlternative: boolean;
}
const cityNameIdentity = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[œŒ]/gu, "oe")
    .replace(/[.'’]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
/** A typed-QA-only operation scope: exact requested place, or an explicitly displayed same-city US alternative. */
export function resolveTypedNwsReadScope(
  part: SharedPublicSearchPart,
  requestedQuery: string,
): TypedNwsReadScope | undefined {
  if (
    part.requirement.domain !== "weather" ||
    !isSimpleCurrentTemperatureRequest(part.message) ||
    !isSharedPublicSearchSafe(requestedQuery)
  )
    return undefined;
  const prefix = "current public weather in ";
  const originalQuery = part.requirement.query.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const operationQuery = requestedQuery.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    !originalQuery.toLowerCase().startsWith(prefix) ||
    !operationQuery.toLowerCase().startsWith(prefix)
  )
    return undefined;
  const requestedPlace = weatherLocationWithoutTemperatureUnit(
    originalQuery.slice(prefix.length),
  ).trim();
  const actualPlace = weatherLocationWithoutTemperatureUnit(
    operationQuery.slice(prefix.length),
  ).trim();
  const producerQuery = prefix + actualPlace;
  const actual = parseExplicitUsWeatherQuery(producerQuery);
  if (!actual) return undefined;
  const exact = parseExplicitUsWeatherQuery(prefix + requestedPlace);
  if (exact) {
    if (
      cityNameIdentity(exact.city) !== cityNameIdentity(actual.city) ||
      exact.state !== actual.state
    )
      return undefined;
    return {
      requestedQuery,
      producerQuery: `${prefix}${exact.city}, ${exact.state}`,
      namedPlaceAlternative: false,
    };
  }
  const pieces = requestedPlace.split(",").map((piece) => piece.trim());
  const allowedCountry =
    pieces.length === 2 && /^(?:US|USA|United States(?: of America)?)$/iu.test(pieces[1]);
  if (pieces.length !== 1 && !allowedCountry) return undefined;
  const bare = pieces[0];
  if (
    !/^[\p{L}][\p{L} .'’-]*$/u.test(bare) ||
    cityNameIdentity(bare) !== cityNameIdentity(actual.city)
  )
    return undefined;
  return {
    requestedQuery,
    producerQuery: `${prefix}${bare}, ${actual.state}`,
    namedPlaceAlternative: true,
  };
}
