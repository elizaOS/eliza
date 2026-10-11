/**
 * The link-extraction evaluator (`linkExtractionEvaluator`) for the
 * basic-capabilities bundle: an inbound auto-capture evaluator that scans
 * incoming message text for http(s) URLs, fetches a title/summary preview for
 * each, and persists them as `link` memories in the `links` table.
 *
 * Registered through `evaluators/index.ts`. URLs are attacker-controlled, so
 * every preview fetch is routed through the SSRF guard (`fetchWithSsrfGuard`),
 * and the summary is produced by a `TEXT_SMALL` model call over the fetched
 * page body. Capture is best-effort: the raw URL is still persisted when the
 * preview fetch or summarization fails, per-message URLs are deduped, and
 * per-URL errors are logged and swallowed so
 * the evaluator never blocks the planner.
 */

import type {
  Evaluator,
  IAgentRuntime,
  JSONSchema,
  Memory,
} from "@elizaos/core";
import {
  asUUID,
  fetchWithSsrfGuard,
  MemoryType,
  ModelType,
  stripHtmlRawTextElements,
} from "@elizaos/core";
import { v4 } from "uuid";
import { EvaluatorPriority } from "../../../services/evaluator-priorities.ts";

const EVALUATOR_NAME = "linkExtraction";
const EVALUATOR_SOURCE = "link_extraction_evaluator";
const MEMORY_TABLE = "links";
const URL_REGEX = /https?:\/\/[^\s<>"'`)]+/gi;
const SUMMARY_FETCH_TIMEOUT_MS = 5_000;

interface LinkRecord {
  url: string;
  title: string;
  summary: string;
}

interface LinkExtractionPrepared {
  links: LinkRecord[];
}

interface LinkExtractionOutput {
  processed: boolean;
}

const SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    processed: { type: "boolean" },
  },
  required: ["processed"],
  additionalProperties: false,
};

function getMessageText(message: Memory): string {
  const content = message.content;
  if (!content) {
    return "";
  }
  const text = content.text;
  return typeof text === "string" ? text : "";
}

function getMessageSource(message: Memory): string {
  const source = message.content?.source;
  return typeof source === "string" && source.length > 0 ? source : "unknown";
}

function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX);
  if (!matches) {
    return [];
  }
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of matches) {
    const trimmed = stripTrailingPunctuation(raw);
    if (!trimmed) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    urls.push(trimmed);
  }
  return urls;
}

function stripTrailingPunctuation(url: string): string {
  let result = url;
  while (result.length > 0 && /[.,;:!?\])}>]/.test(result.slice(-1))) {
    result = result.slice(0, -1);
  }
  return result;
}

function hasUrl(message: Memory): boolean {
  const text = getMessageText(message);
  if (!text) {
    return false;
  }
  URL_REGEX.lastIndex = 0;
  return URL_REGEX.test(text);
}

function extractTitle(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    return decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, " ").trim();
  }
  const ogMatch = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  );
  if (ogMatch?.[1]) {
    return decodeHtmlEntities(ogMatch[1]).trim();
  }
  return "";
}

// WHATWG windows-1252 mapping for the C1 range 0x80-0x9F. Numeric references
// in that range resolve to these characters, not to C1 controls. Slots the
// standard leaves unassigned (0x81, 0x8D, 0x8F, 0x90, 0x9D) are absent and
// stay as written.
const WINDOWS_1252_C1 = new Map<number, string>([
  [0x80, "€"],
  [0x82, "‚"],
  [0x83, "ƒ"],
  [0x84, "„"],
  [0x85, "…"],
  [0x86, "†"],
  [0x87, "‡"],
  [0x88, "ˆ"],
  [0x89, "‰"],
  [0x8a, "Š"],
  [0x8b, "‹"],
  [0x8c, "Œ"],
  [0x8e, "Ž"],
  [0x91, "‘"],
  [0x92, "’"],
  [0x93, "“"],
  [0x94, "”"],
  [0x95, "•"],
  [0x96, "–"],
  [0x97, "—"],
  [0x98, "˜"],
  [0x99, "™"],
  [0x9a, "š"],
  [0x9b, "›"],
  [0x9c, "œ"],
  [0x9e, "ž"],
  [0x9f, "Ÿ"],
]);

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
    "#39": "'",
  };
  return value.replace(
    /&(amp|lt|gt|quot|#39|nbsp|#[0-9]+|#x[0-9a-f]+);/gi,
    (entity, name: string) => {
      const key = name.toLowerCase();
      const named = namedEntities[key];
      if (named !== undefined) return named;
      // Page titles use numeric references for punctuation WordPress-style
      // (&#8217; &#8220; &#8211;) and Word/Outlook C1 bytes (&#128;-&#159;).
      // HTML resolves 0x80-0x9F through windows-1252, not to C1 controls.
      const hex = /^#x([0-9a-f]+)$/.exec(key);
      const code = Number.parseInt(hex ? hex[1] : key.slice(1), hex ? 16 : 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) {
        return entity;
      }
      if (code >= 0xd800 && code <= 0xdfff) return entity;
      if (code >= 0x80 && code <= 0x9f) {
        return WINDOWS_1252_C1.get(code) ?? entity;
      }
      if (code === 0xa0) return " ";
      return String.fromCodePoint(code);
    },
  );
}

function stripTags(html: string): string {
  return stripHtmlRawTextElements(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * DNS + transport injection for the guarded preview fetch — the deterministic-test
 * seam. On a Node-like runtime `fetchWithSsrfGuard` defaults to the node-pinned
 * transport (its DNS-rebinding defense), which bypasses a stubbed `globalThis.fetch`
 * by design; tests therefore inject the pinned pair here to drive the REAL guard
 * over a deterministic wire rather than stubbing a fetch the guard never calls.
 * Undefined in production — the guard uses its node defaults.
 */
type LinkPreviewTransport = Pick<
  Parameters<typeof fetchWithSsrfGuard>[0],
  "fetchImpl" | "lookupFn" | "pinnedFetchImpl"
>;

let linkPreviewTransportForTests: LinkPreviewTransport | undefined;

/** Test seam — inject (or clear with `undefined`) the guarded preview transport. */
export function _setLinkPreviewTransportForTests(
  transport: LinkPreviewTransport | undefined,
): void {
  linkPreviewTransportForTests = transport;
}

async function fetchLinkPreview(
  url: string,
): Promise<{ title: string; bodyChunk: string } | null> {
  // URLs come straight from inbound message text, so this fetch is attacker-
  // controlled — route it through the SSRF guard (DNS-pinned, private/internal
  // targets blocked, redirects validated per hop). Any failure (blocked,
  // invalid, timeout, network) → no preview.
  let release: (() => Promise<void>) | undefined;
  try {
    const guarded = await fetchWithSsrfGuard({
      url,
      timeoutMs: SUMMARY_FETCH_TIMEOUT_MS,
      init: {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "Mozilla/5.0 (compatible; ElizaLinkPreview/1.0)",
        },
      },
      ...linkPreviewTransportForTests,
    });
    release = guarded.release;
    const { response } = guarded;
    if (!response.ok) {
      return null;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(contentType)) {
      return null;
    }
    const html = await response.text();
    const title = extractTitle(html);
    const bodyChunk = stripTags(html);
    return { title, bodyChunk };
  } catch {
    // error-policy:J4 link previews are optional enrichments; blocked,
    // unreachable, or invalid external URLs produce no preview.
    return null;
  } finally {
    await release?.();
  }
}

async function summarizeLink(
  runtime: IAgentRuntime,
  url: string,
  title: string,
  bodyChunk: string,
): Promise<string> {
  if (!bodyChunk.trim()) {
    return "";
  }
  const prompt = `Summarize the following web page in one short paragraph (max 3 sentences). Focus on what the page is about. Do not invent details.

URL: ${url}
Title: ${title || "(unknown)"}
Body excerpt:
${bodyChunk}

Summary:`;
  const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
  if (typeof response === "string") {
    return response.trim();
  }
  return "";
}

async function buildLinkRecord(
  runtime: IAgentRuntime,
  url: string,
): Promise<LinkRecord> {
  const baseRecord: LinkRecord = {
    url,
    title: "",
    summary: "",
  };
  const preview = await fetchLinkPreview(url);
  if (!preview) {
    return baseRecord;
  }
  baseRecord.title = preview.title;
  try {
    baseRecord.summary = await summarizeLink(
      runtime,
      url,
      preview.title,
      preview.bodyChunk,
    );
  } catch (error) {
    // error-policy:J4 Link enrichment is optional; report the unavailable
    // summary while preserving the original message.
    runtime.logger.warn(
      {
        src: "evaluator:link-extraction",
        agentId: runtime.agentId,
        url,
        err: error instanceof Error ? error.message : String(error),
      },
      "Link summarization failed",
    );
    runtime.reportError("LinkExtraction.summarize", error, { url });
  }
  return baseRecord;
}

async function persistLink(
  runtime: IAgentRuntime,
  message: Memory,
  link: LinkRecord,
): Promise<void> {
  const text = link.summary || link.title || link.url;
  const platform = getMessageSource(message);
  const memory: Memory = {
    id: asUUID(v4()),
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId: message.roomId,
    content: {
      text,
      type: "link",
      source: EVALUATOR_SOURCE,
      platform,
      url: link.url,
    },
    metadata: {
      type: MemoryType.CUSTOM,
      source: EVALUATOR_SOURCE,
      platform,
      sourceId: message.id,
      tags: ["link", "auto_capture", `platform:${platform}`],
      url: link.url,
      title: link.title,
      summary: link.summary,
      timestamp: Date.now(),
    },
    createdAt: Date.now(),
  };

  await runtime.createMemory(memory, MEMORY_TABLE, false);
}

export const linkExtractionEvaluator: Evaluator<
  LinkExtractionOutput,
  LinkExtractionPrepared
> = {
  name: EVALUATOR_NAME,
  description:
    "Auto-captures http(s) URLs from inbound message text, optionally fetches a title/summary, and persists them as link memories.",
  priority: EvaluatorPriority.INBOUND_LINK_EXTRACTION,
  schema: SCHEMA,

  async shouldRun({ message }) {
    return hasUrl(message);
  },

  async prepare({ runtime, message }) {
    const text = getMessageText(message);
    const urls = extractUrls(text);
    const links: LinkRecord[] = [];

    for (const url of urls) {
      try {
        const record = await buildLinkRecord(runtime, url);
        links.push(record);
        await persistLink(runtime, message, record);
      } catch (error) {
        // error-policy:J4 Links are independent enrichment items; report
        // one failed URL while processing the rest.
        runtime.logger.warn(
          {
            src: "evaluator:link-extraction",
            agentId: runtime.agentId,
            url,
            err: error instanceof Error ? error.message : String(error),
          },
          "Link extraction failed",
        );
        runtime.reportError("LinkExtraction.extract", error, { url });
      }
    }

    return { links };
  },

  prompt({ prepared }) {
    return `Runtime captured/persisted ${prepared.links.length} http(s) URL(s). Return {"processed":true}.`;
  },

  // prepare already fetched, summarized and durably captured the links. A
  // second model call over the entire room cannot add evidence to this result.
  resolveOutput() {
    return { processed: true };
  },

  parse(output) {
    if (output && typeof output === "object" && !Array.isArray(output)) {
      const record = output as Record<string, unknown>;
      return { processed: record.processed === true };
    }
    return { processed: false };
  },
};
