/**
 * WEB_FETCH gives the headless coding agent a direct, hardened URL reader.
 * The action is intentionally plugin-local so coding-only examples do not need
 * the full agent runtime action bundle, while the network guard remains shared
 * through core.
 *
 * A body longer than one page is returned as a progressive read: one page, a
 * header that names the omitted range and the exact continuation call, and a
 * `tool-result` ReadView. A continuation fetches the URL again and reads on
 * only while the body still hashes to the first page's SHA-256 revision.
 */
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  buildReadSlice,
  buildReadView,
  sha256Text,
  stripHtmlRawTextElements,
  toWellFormedUnicode,
} from "@elizaos/core";
import { decodeHTML } from "entities";
import {
  failureToActionResult,
  readNumberParam,
  readStringParam,
  successActionResult,
} from "../lib/format.js";
import {
  DEFAULT_PAGE_CHARS,
  normalizePageEnd,
  normalizePageStart,
} from "../lib/text-boundary.js";
import { guardedTextHttpRequest } from "../lib/web-http.js";
import { CODING_TOOLS_CONTEXTS } from "../types.js";

/**
 * Capability kill switch, mirroring the agent-runtime WEB_FETCH action:
 * `ELIZA_WEB_FETCH=0|false|off` disables outbound fetches. Checked at
 * `validate` AND at handler entry so a disabled capability never runs even
 * when the action was registered or invoked through another path.
 */
export function isCodingWebFetchEnabled(): boolean {
  const raw = process.env.ELIZA_WEB_FETCH?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

function decodeHtmlEntity(entity: string): string {
  if (entity.startsWith("#")) {
    const code = entity.startsWith("#x")
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    // Exclude the UTF-16 surrogate range as well as values outside Unicode.
    // Once this scalar-value guard passes, String.fromCodePoint cannot throw.
    const isUnicodeScalarValue =
      Number.isInteger(code) &&
      code >= 0 &&
      code <= 0x10ffff &&
      (code < 0xd800 || code > 0xdfff);
    // The numeric spellings of U+00A0 (&#160; / &#xA0;) decode to the same
    // character as &nbsp;, so they must become the same readable plain space.
    return isUnicodeScalarValue
      ? String.fromCodePoint(code).replace(/\u00a0/g, " ")
      : `&${entity};`;
  }
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
      /&([a-zA-Z][a-zA-Z0-9]+|#[0-9]+|#x[0-9a-fA-F]+);/g,
      (_m, entity: string) => decodeHtmlEntity(entity),
    );
  const body = normalizeWhitespace(text);
  const normalizedTitle = title
    ? normalizeWhitespace(
        title.replace(
          /&([a-zA-Z][a-zA-Z0-9]+|#[0-9]+|#x[0-9a-fA-F]+);/g,
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

/**
 * Paths one extract list is read for. Each miss is reported in the result, so
 * the list is bounded.
 */
const MAX_JSON_EXTRACT_PATHS = 32;

function describeJsonValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "string") return `string(${value.length} chars)`;
  if (typeof value === "object") {
    return `object(${Object.keys(value as object).length} keys)`;
  }
  return typeof value;
}

type PathResolution = { value: unknown } | { miss: string };

/**
 * Resolves one extract path from `root`, or says where it stopped and what
 * was there. The path is dotted keys, with `$`, `[n]` and `[*]` read as their
 * dotted form (`$.items[2].name` is `items.2.name`). A `*` key maps the rest
 * of the path over every array item (keeping positions, null where an item
 * lacks it) or object value, and resolves while at least one of them does.
 */
function resolveExtractPath(root: unknown, path: string): PathResolution {
  const dotted = path
    .replace(/^\$(?=\.|\[|$)/, "")
    .replace(/\[(\d+|\*)\]/g, ".$1")
    .replace(/^\./, "");
  const keys = dotted.split(".");
  if (
    dotted.length === 0 ||
    dotted.length > MAX_JSON_EXTRACT_PATH_LENGTH ||
    keys.length > MAX_JSON_EXTRACT_DEPTH ||
    keys.some(
      (key) => key.length === 0 || key.length > MAX_JSON_EXTRACT_SEGMENT_LENGTH,
    )
  ) {
    return {
      miss: `not a valid path (an empty segment, over ${MAX_JSON_EXTRACT_DEPTH} segments, a segment over ${MAX_JSON_EXTRACT_SEGMENT_LENGTH} characters, or over ${MAX_JSON_EXTRACT_PATH_LENGTH} characters)`,
    };
  }
  const missAt = (at: number, current: unknown): PathResolution => {
    const key = keys[at] as string;
    const where = at === 0 ? "the response root" : keys.slice(0, at).join(".");
    const wanted =
      key === "*"
        ? "items"
        : Array.isArray(current) && /^\d+$/.test(key)
          ? `index ${key}`
          : JSON.stringify(key);
    const mapped =
      Array.isArray(current) && key !== "*" && !/^\d+$/.test(key)
        ? `; ${[...keys.slice(0, at), "*", ...keys.slice(at)].join(".")} reads it from every item`
        : "";
    return {
      miss: `${where} is ${describeJsonValue(current)} with no ${wanted}${mapped}`,
    };
  };
  const walk = (current: unknown, at: number): PathResolution => {
    if (at === keys.length) return { value: current };
    if (current === null || typeof current !== "object")
      return missAt(at, current);
    const key = keys[at] as string;
    if (key === "*") {
      const entries: [string, unknown][] = Array.isArray(current)
        ? current.map((item, index) => [String(index), item])
        : Object.entries(current as Record<string, unknown>);
      let firstMiss: PathResolution | undefined;
      let hits = 0;
      const mapped = entries.map(([entryKey, item]): [string, unknown] => {
        const resolved = walk(item, at + 1);
        if ("miss" in resolved) {
          firstMiss ??= resolved;
          return [entryKey, null];
        }
        hits++;
        return [entryKey, resolved.value];
      });
      if (firstMiss && hits === 0) return firstMiss;
      return {
        value: Array.isArray(current)
          ? mapped.map(([, value]) => value)
          : Object.fromEntries(mapped),
      };
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current as object, key);
    } catch {
      return missAt(at, current);
    }
    if (!descriptor || !("value" in descriptor)) return missAt(at, current);
    return walk(descriptor.value, at + 1);
  };
  return walk(root, 0);
}

interface ExtractedBody {
  value: string;
  kind: "html" | "json" | "text";
  /** Each extract path that did not resolve, with where it stopped. */
  extractMisses?: Record<string, string>;
}

/**
 * Applies `extract` to parsed JSON. One path yields its value; several
 * comma-separated paths yield an object keyed by path as written. Only the
 * first MAX_JSON_EXTRACT_PATHS paths are read; the rest are reported as one
 * entry, so the misses stay as small as the list allowed.
 */
function extractJson(parsed: unknown, extract: string): ExtractedBody {
  const listed = [
    ...new Set(
      extract
        .split(",")
        .map((path) => path.trim())
        .filter(Boolean),
    ),
  ];
  const paths =
    listed.length > 0 ? listed.slice(0, MAX_JSON_EXTRACT_PATHS) : [extract];
  const values = new Map<string, unknown>();
  const misses = new Map<string, string>();
  for (const path of paths) {
    const resolved = resolveExtractPath(parsed, path);
    if ("miss" in resolved) misses.set(path, resolved.miss);
    else values.set(path, resolved.value);
  }
  if (listed.length > paths.length) {
    misses.set(
      `(${listed.length - paths.length} more paths)`,
      `not read: extract reads at most ${MAX_JSON_EXTRACT_PATHS} paths and this one lists ${listed.length}; * reads a field from every item in one path (*.name), so never list indexes one by one`,
    );
  }
  const reported =
    misses.size > 0 ? { extractMisses: Object.fromEntries(misses) } : {};
  // A path that resolves nowhere must not hard-fail the fetch: the full JSON
  // comes back with every miss reported, so it is never mistaken for the field.
  if (values.size === 0) {
    return { value: JSON.stringify(parsed), kind: "json", ...reported };
  }
  return {
    value: JSON.stringify(
      paths.length === 1
        ? values.get(paths[0] as string)
        : Object.fromEntries(values),
    ),
    kind: "json",
    ...reported,
  };
}

function extractBody(
  body: string,
  contentType: string,
  extract: string | undefined,
): ExtractedBody {
  const type = contentType.toLowerCase();
  const trimmed = body.trim();
  if (type.includes("html")) {
    return { value: htmlToReadableText(body), kind: "html" };
  }
  // extract names a JSON path, so a body served as text/plain (raw files)
  // that looks like JSON is parsed for it.
  if (
    type.includes("json") ||
    ((!type || extract !== undefined) &&
      (trimmed.startsWith("{") || trimmed.startsWith("[")))
  ) {
    try {
      const parsed = JSON.parse(body) as unknown;
      return extract
        ? extractJson(parsed, extract)
        : { value: JSON.stringify(parsed), kind: "json" };
    } catch {
      // error-policy:J4 Malformed JSON falls back to raw text extraction rather than failing
      return { value: body.trim(), kind: "text" };
    }
  }
  return { value: body.trim(), kind: "text" };
}

interface FetchedBody extends ExtractedBody {
  /** The URL and extract the model asked for; continuations must repeat them. */
  url: string;
  extract: string | undefined;
  revision: string;
  metadata: {
    final_url: string;
    status: number;
    content_type: string;
    retrieved_at: string;
  };
}

function bodyResultData(body: FetchedBody): Record<string, unknown> {
  return {
    action: "WEB_FETCH",
    url: body.url,
    ...body.metadata,
    retrieved_at_basis:
      "HTTP retrieval completed; not the source publication or market update time",
    kind: body.kind,
    truncated: false,
    ...(body.extract === undefined
      ? {}
      : {
          extract_resolved: body.kind === "json" && !body.extractMisses,
          ...(body.extractMisses
            ? { extract_unresolved: body.extractMisses }
            : {}),
        }),
  };
}

/**
 * One page of a body longer than a page. The header names the shown and
 * omitted ranges and the exact call that reads on; nothing is dropped
 * without the model being told where it is.
 */
function pagedBodyResult(body: FetchedBody, offset: number): ActionResult {
  const total = body.value.length;
  if (offset >= total) {
    return failureToActionResult(
      {
        reason: "invalid_param",
        message: `offset ${offset} is at or beyond the end of this body (${total} characters)`,
      },
      { action: "WEB_FETCH", url: body.url, total_characters: total },
    );
  }
  const start = normalizePageStart(body.value, offset);
  const end = normalizePageEnd(body.value, start, DEFAULT_PAGE_CHARS);
  const hasMore = end < total;
  const page = body.value.slice(start, end);
  const shown = `characters ${start}-${end} of ${total} (${body.kind})`;
  const nextCall = JSON.stringify({
    url: body.url,
    ...(body.extract !== undefined ? { extract: body.extract } : {}),
    offset: end,
    expectedRevision: body.revision,
  });
  const header = hasMore
    ? `[WEB_FETCH partial body: ${shown}. The remaining ${total - end} characters are not shown here. Read the next page with WEB_FETCH ${nextCall}; it fetches the URL again and fails as stale_read if the body changed.]`
    : `[WEB_FETCH body: ${shown}; final page.]`;
  const readView = buildReadView({
    reference: {
      kind: "tool-result",
      ref: `web_fetch:${body.revision}`,
      revision: body.revision,
      // WEB_FETCH continues by url, offset and expectedRevision; nothing
      // resolves this token.
      resumability: "non-resumable",
    },
    slice: buildReadSlice({
      range: { unit: "fragment", start, end, total },
      completeness: hasMore ? "partial-recoverable" : "complete",
      revision: body.revision,
      sliceSha256: sha256Text(page),
      sourceSha256: body.revision,
    }),
  });
  return successActionResult(`${header}\n\n${page}`, {
    ...bodyResultData(body),
    readView,
  });
}

export const webFetchAction: Action = {
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
    "fetch ONE specific URL, JSON API, or data file whose address you have or can construct exactly -> WEB_FETCH; this is the exact-and-fresh path for live NOW-values: spot crypto price -> https://api.coingecko.com/api/v3/simple/price?ids=<coin>&vs_currencies=usd, current weather -> https://wttr.in/<city>?format=j1; to discover pages with no constructable URL -> WEB_SEARCH",
  description:
    "Fetch one specific public HTTPS URL and return readable text. Supports HTML extraction, JSON, and plain text. Prefer this over WEB_SEARCH for live NOW-values (spot prices, exchange rates, current weather) by constructing the live API URL yourself. A long body returns one page plus the exact call (offset, expectedRevision) that reads the next page. Blocks private/internal hosts, redirects to private/internal hosts, non-HTTPS URLs, binary content, oversized reads, and timeouts.",
  parameters: [
    {
      name: "url",
      description: "Absolute public https URL to fetch.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "extract",
      description:
        'Optional JSON fields to return instead of the whole JSON body. A dotted path, array indexes as numbers (0.name); * maps over every array item or object value (*.tag_name), so never list indexes one by one; several paths comma-separated return an object keyed by path ("*.tag_name, *.prerelease").',
      required: false,
      schema: { type: "string" },
    },
    {
      name: "offset",
      description:
        "For continuation only: the character offset named by the previous WEB_FETCH page. Omit on a first fetch.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "expectedRevision",
      description:
        "For continuation only: copy the revision named by the previous WEB_FETCH page. Required with a nonzero offset.",
      required: false,
      schema: { type: "string" },
    },
  ],
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
    const url = readStringParam(options, "url")?.trim();
    const extract = readStringParam(options, "extract")?.trim() || undefined;
    if (!url) {
      return failureToActionResult({
        reason: "missing_param",
        message: "url is required",
      });
    }
    const offset = readNumberParam(options, "offset") ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return failureToActionResult({
        reason: "invalid_param",
        message: "offset must be a non-negative integer",
      });
    }
    const expectedRevision =
      readStringParam(options, "expectedRevision")?.trim() || undefined;
    if (offset > 0 && !expectedRevision) {
      return failureToActionResult({
        reason: "missing_param",
        message:
          "expectedRevision is required with a nonzero offset; copy it from the WEB_FETCH page that named this offset, or fetch again without offset",
      });
    }

    try {
      const response = await guardedTextHttpRequest(url);
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

      const extracted = extractBody(
        response.text,
        response.contentType,
        extract,
      );
      const wellFormed = toWellFormedUnicode(extracted.value);
      const body: FetchedBody = {
        ...extracted,
        value: wellFormed,
        url,
        extract,
        revision: sha256Text(wellFormed),
        metadata: {
          final_url: response.url,
          status: response.status,
          content_type: response.contentType,
          retrieved_at: retrievedAt,
        },
      };
      // A changed body cannot continue a read past its start, but page 0 has
      // no earlier pages to disagree with: serve it at the new revision.
      if (
        expectedRevision &&
        offset > 0 &&
        body.revision !== expectedRevision
      ) {
        return failureToActionResult(
          {
            reason: "stale_read",
            message: `the body at ${url} changed since revision ${expectedRevision.slice(0, 12)} (now ${body.revision.slice(0, 12)}), so its earlier pages cannot be continued exactly; fetch again without offset and expectedRevision to start a fresh read`,
          },
          {
            action: "WEB_FETCH",
            url,
            expected_revision: expectedRevision,
            current_revision: body.revision,
          },
        );
      }
      if (offset === 0 && wellFormed.length <= DEFAULT_PAGE_CHARS) {
        return successActionResult(wellFormed, bodyResultData(body));
      }
      return pagedBodyResult(body, offset);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = failureToActionResult(
        { reason: "io_error", message: withUpstreamFallbackHint(message, url) },
        { action: "WEB_FETCH", url },
      );
      return result;
    }
  },
};

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
