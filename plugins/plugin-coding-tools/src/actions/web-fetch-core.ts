/**
 * WEB_FETCH gives the headless coding agent a direct, hardened URL reader.
 * The action is intentionally plugin-local so coding-only examples do not need
 * the full agent runtime action bundle, while the network guard remains shared
 * through core.
 */
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { stripHtmlRawTextElements, toWellFormedUnicode } from "@elizaos/core";
import { decodeHTML } from "entities";
import {
  failureToActionResult,
  readStringParam,
  successActionResult,
} from "../lib/format.js";
import { CODING_TOOLS_CONTEXTS } from "../types.js";

/**
 * Capability kill switch, mirroring the agent-runtime WEB_FETCH action:
 * `ELIZA_WEB_FETCH=0|false|off` disables outbound fetches. Checked at
 * `validate` AND at handler entry so a disabled capability never runs even
 * when the action was registered or invoked through another path.
 */
export function isCodingWebFetchEnabled(): boolean {
  const raw =
    typeof process === "undefined"
      ? undefined
      : process.env.ELIZA_WEB_FETCH?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

// The five C1 slots that windows-1252 leaves unassigned. The entities
// decoder maps them to the raw C1 control character; leave them as written
// instead, like the reference decoder does.
const UNASSIGNED_C1_CODES = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

function decodeHtmlEntity(entity: string): string {
  if (entity.startsWith("#")) {
    // The hex marker is case-insensitive in HTML (&#X27; === &#x27;), as both
    // in-repo reference decoders (plugin-assistant, cloud gmail) accept.
    const code =
      entity[1] === "x" || entity[1] === "X"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
    // Exclude the UTF-16 surrogate range as well as values outside Unicode.
    const isUnicodeScalarValue =
      Number.isInteger(code) &&
      code > 0 &&
      code <= 0x10ffff &&
      (code < 0xd800 || code > 0xdfff);
    if (!isUnicodeScalarValue) return `&${entity};`;
    if (UNASSIGNED_C1_CODES.has(code)) return `&${entity};`;
  }
  // decodeHTML decodes numeric references through the WHATWG windows-1252
  // table (&#150; -> U+2013, &#128; -> U+20AC). The numeric spellings of
  // U+00A0 (&#160; / &#xA0;) decode to the same character as &nbsp;, so they
  // must become the same readable plain space.
  return decodeHTML(`&${entity};`).replace(/\u00a0/g, " ");
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ +([.,;:!?])/g, "$1")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToReadableText(html: string): string {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const withoutNoise = stripHtmlRawTextElements(html)
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ");
  const text = withoutNoise
    .replace(
      /<\/?(?:h[1-6]|p|div|section|article|main|header|footer|li|ul|ol|tr|br)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ")
    .replace(
      /&([a-zA-Z][a-zA-Z0-9]+|#[0-9]+|#[xX][0-9a-fA-F]+);/g,
      (_m, entity: string) => decodeHtmlEntity(entity),
    );
  const body = normalizeWhitespace(text);
  const normalizedTitle = title
    ? normalizeWhitespace(
        title.replace(
          /&([a-zA-Z][a-zA-Z0-9]+|#[0-9]+|#[xX][0-9a-fA-F]+);/g,
          (_m, entity: string) => decodeHtmlEntity(entity),
        ),
      )
    : "";
  if (normalizedTitle && !body.startsWith(normalizedTitle)) {
    return normalizeWhitespace(`${normalizedTitle}\n\n${body}`);
  }
  return body;
}

const MAX_JSON_EXTRACT_DEPTH = 16;
const MAX_JSON_EXTRACT_PATH_LENGTH = 1024;
const MAX_JSON_EXTRACT_SEGMENT_LENGTH = 256;

function resolveJsonPath(root: unknown, path: string): unknown {
  if (path.length === 0 || path.length > MAX_JSON_EXTRACT_PATH_LENGTH)
    return undefined;
  const segments: { key: string; arrayIndex: boolean }[] = [];
  for (const [position, part] of path.split(".").entries()) {
    const match = /^([^.[\]]*)((?:\[(?:0|[1-9]\d*)\])*)$/.exec(part);
    if (!match || (!match[1] && (position !== 0 || !match[2])))
      return undefined;
    if (match[1]) segments.push({ key: match[1], arrayIndex: false });
    for (const index of match[2].matchAll(/\[(\d+)\]/g)) {
      if (!Number.isSafeInteger(Number(index[1]))) return undefined;
      segments.push({ key: index[1], arrayIndex: true });
    }
    if (segments.length > MAX_JSON_EXTRACT_DEPTH) return undefined;
  }
  let current = root;
  for (const { key, arrayIndex } of segments) {
    if (
      key.length === 0 ||
      key.length > MAX_JSON_EXTRACT_SEGMENT_LENGTH ||
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor" ||
      (arrayIndex && !Array.isArray(current))
    )
      return undefined;
    if (current === null || typeof current !== "object") return undefined;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current as object, key);
    } catch {
      // error-policy:J3 Untrusted path traversal cannot invoke object accessors.
      return undefined;
    }
    if (!descriptor || !("value" in descriptor)) return undefined;
    current = descriptor.value;
  }
  return current;
}

function extractBody(
  body: string,
  contentType: string,
  extract: string | undefined,
): { value: string; kind: "html" | "json" | "text" } {
  const type = contentType.toLowerCase();
  const trimmed = body.trim();
  if (type.includes("html")) {
    return { value: htmlToReadableText(body), kind: "html" };
  }
  if (
    type.includes("json") ||
    ((!type || Boolean(extract)) &&
      (trimmed.startsWith("{") || trimmed.startsWith("[")))
  ) {
    try {
      const parsed = JSON.parse(body) as unknown;
      const selected = extract ? resolveJsonPath(parsed, extract) : parsed;
      // A fuzzy or unresolved extract path must not hard-fail the fetch: fall back
      // to the full JSON so the model can still read it and pick out what it needs,
      // rather than surfacing an io_error for a best-effort path hint.
      const jsonValue = extract && selected === undefined ? parsed : selected;
      return { value: JSON.stringify(jsonValue), kind: "json" };
    } catch {
      // error-policy:J4 Malformed JSON falls back to raw text extraction rather than failing
      return { value: body.trim(), kind: "text" };
    }
  }
  return { value: body.trim(), kind: "text" };
}

export interface WebFetchOriginRead {
  format: "elizaos.web-fetch.origin.v1";
  requestedAt: number;
  retrievedAt: number;
  url: string;
  status: number;
  contentType: string;
  cache: "no-store";
  redirect: "manual";
  wttr?: {
    nearestArea: {
      name: string;
      country: string;
      latitude: string;
      longitude: string;
    };
    currentCondition: {
      temperatureC: string;
      localObservationTime?: string;
      observationTime: string;
      observationDateBasis:
        | "provider-local-date"
        | "server-derived-for-validation";
    };
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** This is a verification projection, never a replacement for complete action text. */
function originRead(
  response: WebFetchOriginResult,
): WebFetchOriginRead | undefined {
  if (
    !Number.isSafeInteger(response.requestedAt) ||
    !Number.isSafeInteger(response.retrievedAt)
  )
    return undefined;
  const receipt: WebFetchOriginRead = {
    format: "elizaos.web-fetch.origin.v1",
    requestedAt: Number(response.requestedAt),
    retrievedAt: Number(response.retrievedAt),
    url: response.url,
    status: response.status,
    contentType: response.contentType,
    cache: "no-store",
    redirect: "manual",
  };
  if (new TextEncoder().encode(JSON.stringify(receipt)).byteLength > 2048)
    return undefined;
  if (new URL(response.url).origin !== "https://wttr.in") return receipt;
  let value: unknown;
  try {
    value = JSON.parse(response.text);
  } catch {
    // error-policy:J3 Malformed origin JSON has no structured weather authority.
    return receipt;
  }
  const body = object(value);
  const area =
    Array.isArray(body?.nearest_area) && body.nearest_area.length === 1
      ? object(body.nearest_area[0])
      : undefined;
  const condition =
    Array.isArray(body?.current_condition) &&
    body.current_condition.length === 1
      ? object(body.current_condition[0])
      : undefined;
  const label = (value: unknown) =>
    Array.isArray(value) && value.length === 1
      ? object(value[0])?.value
      : undefined;
  const fields = [
    label(area?.areaName),
    label(area?.country),
    area?.latitude,
    area?.longitude,
    condition?.temp_C,
    condition?.observation_time,
  ];
  // Oversized or missing facts remain unavailable; nothing is clipped or inferred.
  if (
    !fields.every(
      (field): field is string =>
        typeof field === "string" && field.length > 0 && field.length <= 128,
    )
  )
    return receipt;
  const [name, country, latitude, longitude, temperatureC, observationTime] =
    fields as [string, string, string, string, string, string];
  const localObservationTime = condition?.localObsDateTime;
  if (
    localObservationTime !== undefined &&
    (typeof localObservationTime !== "string" ||
      localObservationTime.length === 0 ||
      localObservationTime.length > 128)
  )
    return receipt;
  receipt.wttr = {
    nearestArea: { name, country, latitude, longitude },
    currentCondition: {
      temperatureC,
      observationTime,
      ...(typeof localObservationTime === "string"
        ? { localObservationTime }
        : {}),
      observationDateBasis:
        localObservationTime === undefined
          ? "server-derived-for-validation"
          : "provider-local-date",
    },
  };
  return new TextEncoder().encode(JSON.stringify(receipt)).byteLength <= 4096
    ? receipt
    : undefined;
}

export interface WebFetchOriginResult {
  requestedAt?: number;
  retrievedAt?: number;
  requestPolicy?: { method: "GET"; redirect: "manual"; cache: "no-store" };
  kind?: "origin-http";
  ok: boolean;
  status: number;
  url: string;
  contentType: string;
  text: string;
  truncated: false;
}
export interface WebFetchProviderResult {
  kind: "provider-extract";
  provider: "parallel";
  url: string;
  text: string;
  observedAt: number;
  requestedAt?: number;
  truncated: false;
}
export type WebFetchReader = (
  url: string,
  signal?: AbortSignal,
) => Promise<WebFetchOriginResult | WebFetchProviderResult>;
/** Server-bound semantic projection of the actual origin response; absent by default. */
export interface WebFetchEvidencePort {
  /** Optional host-scoped dispatch permission; a supplied evidence port never authorizes arbitrary URLs. */
  authorizeUrl?(url: string): boolean;
  authorizedUrls?(): readonly string[];
  observePublicSearch?(result: ActionResult, query: string): void;
  acceptsOriginUrl?(url: string): boolean;
  projectOrigin?(
    response: Readonly<WebFetchOriginResult>,
  ): Readonly<Record<string, unknown>> | undefined;
  projectProvider?(
    response: Readonly<WebFetchProviderResult>,
  ): Readonly<Record<string, unknown>> | undefined;
}

export function createWebFetchAction(
  reader: WebFetchReader,
  overrides: Partial<
    Pick<
      Action,
      "description" | "routingHint" | "roleGate" | "contexts" | "contextGate"
    >
  > = {},
  readEvidence?: WebFetchEvidencePort,
): Action {
  return {
    name: "WEB_FETCH",
    // "web" belongs alongside the coding contexts: stage-1's routing vocabulary
    // names `web` for live-lookup turns, and an action literally named
    // WEB_SEARCH/WEB_FETCH being unreachable from the `web` context left
    // candidate-less web turns with no web tool on the planner surface
    // (observed live: a weather+note composite surfaced only the CONTACT
    // family).
    contexts: [...CODING_TOOLS_CONTEXTS, "web"],
    contextGate: { anyOf: [...CODING_TOOLS_CONTEXTS, "web"] },
    roleGate: { minRole: "ADMIN" },
    similes: ["LOOKUP_WEB", "WEB_LOOKUP", "FETCH_URL", "HTTP_GET", "GET_URL"],
    routingHint:
      "fetch ONE specific URL, JSON API, or data file whose address you have or can construct exactly -> WEB_FETCH; this is the exact-and-fresh path for live NOW-values: spot crypto price -> https://api.coingecko.com/api/v3/simple/price?ids=<coin>&vs_currencies=usd, current weather -> https://wttr.in/<latitude>,<longitude>?format=j1 (example Tokyo city: 35.6895,139.6917); read nearest_area and observation dates before using extract=current_condition; to discover pages with no constructable URL -> WEB_SEARCH",
    description:
      "Fetch one specific public HTTPS URL and return readable text. Supports HTML extraction, JSON, and plain text. Prefer this over WEB_SEARCH for live NOW-values (spot prices, exchange rates, current weather) by constructing the live API URL yourself. Blocks private/internal hosts, redirects to private/internal hosts, non-HTTPS URLs, binary content, oversized reads, and timeouts.",
    parameters: [
      {
        name: "url",
        description:
          "Absolute public https URL. Every Wttr URL requires latitude,longitude coordinates, regardless of output format (for example https://wttr.in/35.6895,139.6917?format=j1), never an ambiguous place name.",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "extract",
        description:
          "Optional JSON path using dotted properties and numeric array indexes (for example current_condition[0].temp_C).",
        required: false,
        schema: { type: "string" },
      },
    ],
    ...overrides,
    validate: async () => isCodingWebFetchEnabled(),
    handler: async (
      _runtime: IAgentRuntime,
      _message: Memory,
      _state?: State,
      options?: unknown,
      _callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      if (!isCodingWebFetchEnabled()) {
        return failureToActionResult({
          reason: "disabled",
          message: "WEB_FETCH is disabled via ELIZA_WEB_FETCH",
        });
      }
      let url = readStringParam(options, "url")?.trim();
      const extract = readStringParam(options, "extract")?.trim();
      if (!url) {
        return failureToActionResult({
          reason: "missing_param",
          message: "url is required",
        });
      }

      try {
        const input =
          options && typeof options === "object"
            ? (options as { signal?: AbortSignal; abortSignal?: AbortSignal })
            : undefined;
        const signal = input?.abortSignal ?? input?.signal;
        signal?.throwIfAborted();
        const parsedUrl = new URL(url);
        // Canonicalize the caller URL before the reader applies its existing safety policy.
        url = parsedUrl.href;
        if (parsedUrl.hostname.toLowerCase() === "wttr.in") {
          const location = parsedUrl.pathname.slice(1);
          const match = location.match(
            /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/u,
          );
          if (
            !match ||
            Math.abs(Number(match[1])) > 90 ||
            Math.abs(Number(match[2])) > 180
          ) {
            return failureToActionResult(
              {
                reason: "invalid_param",
                message:
                  "Wttr URLs require valid latitude,longitude coordinates for every output format. Resolve the requested place and retry with coordinates; read nearest_area and observation dates before narrowing JSON extraction.",
              },
              { action: "WEB_FETCH", url },
            );
          }
        }
        if (readEvidence && readEvidence.authorizeUrl?.(url) !== true) {
          return failureToActionResult(
            {
              reason: "invalid_param",
              message: "That URL is not authorized for this public request.",
            },
            {
              action: "WEB_FETCH",
              authorizedUrls: [...(readEvidence.authorizedUrls?.() ?? [])],
            },
          );
        }
        const response = await reader(url, signal);
        signal?.throwIfAborted();
        if (response.kind === "provider-extract") {
          const projected = readEvidence?.projectProvider?.(response);
          return successActionResult(response.text, {
            action: "WEB_FETCH",
            url: response.url,
            provider: response.provider,
            read_method: "provider_extract",
            kind: "provider-extract",
            truncated: false,
            retrieved_at: response.observedAt,
            retrieved_at_basis:
              "Provider response received; not origin freshness or publication time",
            ...(extract ? { extract_applied: false } : {}),
            ...(projected
              ? { readEvidence: projected, readOnlyOperation: true }
              : {}),
          });
        }
        const retrievedAt = new Date().toISOString();
        if (!response.ok) {
          const result = failureToActionResult(
            {
              reason: "io_error",
              message: withUpstreamFallbackHint(
                `HTTP ${response.status}`,
                url,
                response.status,
              ),
            },
            {
              action: "WEB_FETCH",
              url,
              final_url: response.url,
              status: response.status,
            },
          );
          return result;
        }

        const receipt = readEvidence ? originRead(response) : undefined;
        const projected = readEvidence?.acceptsOriginUrl?.(url)
          ? readEvidence.projectOrigin?.(response)
          : undefined;
        const extracted = extractBody(
          response.text,
          response.contentType,
          extract,
        );
        const wellFormed = toWellFormedUnicode(extracted.value);
        return successActionResult(wellFormed, {
          action: "WEB_FETCH",
          url,
          final_url: response.url,
          status: response.status,
          content_type: response.contentType,
          retrieved_at: retrievedAt,
          retrieved_at_basis:
            "HTTP retrieval completed; not the source publication or market update time",
          kind: extracted.kind,
          truncated: false,
          ...(receipt ? { originRead: receipt, readOnlyOperation: true } : {}),
          ...(projected ? { readEvidence: projected } : {}),
        });
      } catch (error) {
        const input =
          options && typeof options === "object"
            ? (options as { signal?: AbortSignal; abortSignal?: AbortSignal })
            : undefined;
        (input?.abortSignal ?? input?.signal)?.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        const result = failureToActionResult(
          {
            reason: "io_error",
            message: withUpstreamFallbackHint(message, url),
          },
          { action: "WEB_FETCH", url },
        );
        return result;
      }
    },
  };
}

/**
 * Suggest another read source only when the requested endpoint is unavailable:
 * a 5xx, a 429 or a transport error (including an aborted request timeout) is
 * the endpoint's failure, not the request's, so the failure text names the
 * fallback and the planner tries it before reporting. A 4xx other than 429
 * (bad URL, blocked, gone) and a request rejected before it was sent (policy,
 * malformed URL) carry no hint because retrying elsewhere with the same idea
 * rarely helps.
 */
const TRANSPORT_FAILURE_PATTERN =
  /timeout|timed out|aborted|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|socket|network|reset|refused|unreachable/i;

function withUpstreamFallbackHint(
  message: string,
  url: string,
  status?: number,
): string {
  const upstream =
    status === undefined
      ? TRANSPORT_FAILURE_PATTERN.test(message)
      : status >= 500 || status === 429;
  if (!upstream) return message;
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // error-policy:J3 An invalid URL remains visible as the failed request.
  }
  return `${message} — ${host} failed upstream; try another endpoint or WEB_SEARCH for the same value before telling the user it failed`;
}
