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
import {
  failureToActionResult,
  readStringParam,
  successActionResult,
} from "../lib/format.js";
import { guardedTextHttpRequest } from "../lib/web-http.js";
import { CODING_TOOLS_CONTEXTS } from "../types.js";

const WEB_FETCH_RESULT_CHARS = 8_000;

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
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  if (entity.startsWith("#x")) {
    const code = Number.parseInt(entity.slice(2), 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : `&${entity};`;
  }
  if (entity.startsWith("#")) {
    const code = Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : `&${entity};`;
  }
  return named[entity] ?? `&${entity};`;
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
  const withoutNoise = html
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
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

function resolveJsonPath(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
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
    (!type && (trimmed.startsWith("{") || trimmed.startsWith("[")))
  ) {
    const parsed = JSON.parse(body) as unknown;
    const selected = extract ? resolveJsonPath(parsed, extract) : parsed;
    if (extract && selected === undefined) {
      throw new Error(`JSON extract path not found: ${extract}`);
    }
    return { value: JSON.stringify(selected), kind: "json" };
  }
  return { value: body.trim(), kind: "text" };
}

export const webFetchAction: Action = {
  name: "WEB_FETCH",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: [...CODING_TOOLS_CONTEXTS] },
  roleGate: { minRole: "ADMIN" },
  similes: ["LOOKUP_WEB", "WEB_LOOKUP", "FETCH_URL", "HTTP_GET", "GET_URL"],
  description:
    "Fetch one specific public HTTPS URL and return readable text. Supports HTML extraction, JSON, and plain text. Blocks private/internal hosts, redirects to private/internal hosts, non-HTTPS URLs, binary content, oversized reads, and timeouts.",
  parameters: [
    {
      name: "url",
      description: "Absolute public https URL to fetch.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "extract",
      description: "Optional dotted JSON path when the response is JSON.",
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
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    if (!isCodingWebFetchEnabled()) {
      return failureToActionResult({
        reason: "disabled",
        message: "WEB_FETCH is disabled via ELIZA_WEB_FETCH",
      });
    }
    const url = readStringParam(options, "url")?.trim();
    const extract = readStringParam(options, "extract")?.trim();
    if (!url) {
      return failureToActionResult({
        reason: "missing_param",
        message: "url is required",
      });
    }

    try {
      const response = await guardedTextHttpRequest(url);
      if (!response.ok) {
        const result = failureToActionResult(
          {
            reason: "io_error",
            message: `HTTP ${response.status}`,
          },
          {
            action: "WEB_FETCH",
            url,
            final_url: response.url,
            status: response.status,
          },
        );
        if (callback)
          await callback({ text: result.text, source: "coding-tools" });
        return result;
      }

      const extracted = extractBody(
        response.text,
        response.contentType,
        extract,
      );
      const value =
        extracted.value.length > WEB_FETCH_RESULT_CHARS
          ? `${extracted.value.slice(0, WEB_FETCH_RESULT_CHARS)}\n[truncated]`
          : extracted.value;
      return successActionResult(value, {
        action: "WEB_FETCH",
        url,
        final_url: response.url,
        status: response.status,
        content_type: response.contentType,
        kind: extracted.kind,
        truncated:
          response.truncated || extracted.value.length > WEB_FETCH_RESULT_CHARS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = failureToActionResult(
        { reason: "io_error", message },
        { action: "WEB_FETCH", url },
      );
      if (callback)
        await callback({ text: result.text, source: "coding-tools" });
      return result;
    }
  },
};
