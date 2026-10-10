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
import { extractUrls } from "../../../utils/extract-urls.ts";
import { decodeHttpText } from "../../../utils/http-text.ts";

const EVALUATOR_NAME = "linkExtraction";
const EVALUATOR_SOURCE = "link_extraction_evaluator";
const MEMORY_TABLE = "links";
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

function hasUrl(message: Memory): boolean {
  return extractUrls(getMessageText(message)).length > 0;
}

function extractTitle(html: string): string {
  const title = extractTitleElement(html);
  if (title) {
    return decodeHtmlEntities(title).replace(/\s+/g, " ").trim();
  }
  // HTML attributes are unordered. Requiring property before content drops
  // <meta content="Hello World" property="og:title"> and stores an empty title.
  const ogTitle = extractOpenGraphTitle(html);
  if (ogTitle) {
    return decodeHtmlEntities(ogTitle).trim();
  }
  return "";
}

// The page is untrusted. A tag regex retried at every `<` rescans the rest of a
// page that never closes the tag, so these scans find each end once.

/** Text of the first `<title ...>...</title>`. */
function extractTitleElement(html: string): string {
  const open = /<title/i.exec(html);
  if (!open) return "";
  const start = html.indexOf(">", open.index + open[0].length);
  if (start < 0) return "";
  const close = /<\/title>/gi;
  close.lastIndex = start + 1;
  const end = close.exec(html);
  return end ? html.slice(start + 1, end.index) : "";
}

/**
 * For each index, the `>` that ends a tag whose attributes start there, with
 * quoted values skipped; -1 when the tag never closes. Built right to left.
 */
function tagEnds(html: string): Int32Array {
  const ends = new Int32Array(html.length + 1).fill(-1);
  let nextDouble = -1;
  let nextSingle = -1;
  for (let index = html.length - 1; index >= 0; index--) {
    const char = html[index];
    if (char === ">") ends[index] = index;
    else if (char === '"')
      ends[index] = nextDouble < 0 ? -1 : (ends[nextDouble + 1] as number);
    else if (char === "'")
      ends[index] = nextSingle < 0 ? -1 : (ends[nextSingle + 1] as number);
    else ends[index] = ends[index + 1] as number;
    if (char === '"') nextDouble = index;
    if (char === "'") nextSingle = index;
  }
  return ends;
}

function extractOpenGraphTitle(html: string): string {
  const ends = tagEnds(html);
  const meta = /<meta(?=[\s/>])/gi;
  for (let match = meta.exec(html); match; match = meta.exec(html)) {
    const end = ends[meta.lastIndex] as number;
    if (end < 0) continue;
    const tag = html.slice(match.index, end + 1);
    meta.lastIndex = end + 1;
    let property: string | undefined;
    let content: string | undefined;
    // Consume complete quoted values so title text cannot masquerade as an attribute.
    for (const attribute of tag.matchAll(
      /\s([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
    )) {
      const name = attribute[1].toLowerCase();
      const value = attribute[2] ?? attribute[3] ?? attribute[4];
      if (name === "property") property ??= value;
      if (name === "content") content ??= value;
    }
    if (property?.toLowerCase() === "og:title" && content) return content;
  }
  return "";
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
    "#39": "'",
  };
  return value.replace(
    /&(amp|apos|lt|gt|quot|#39|nbsp);/gi,
    (entity, name: string) => namedEntities[name.toLowerCase()] ?? entity,
  );
}

function stripTags(html: string): string {
  const text = stripHtmlRawTextElements(html);
  let output = "";
  let copied = 0;
  for (let open = text.indexOf("<"); open >= 0; ) {
    const close = text.indexOf(">", open + 1);
    if (close < 0) break;
    if (close > open + 1) {
      output += `${text.slice(copied, open)} `;
      copied = close + 1;
      open = text.indexOf("<", close + 1);
    } else {
      open = text.indexOf("<", open + 1);
    }
  }
  return (output + text.slice(copied)).replace(/\s+/g, " ").trim();
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
    const html = decodeHttpText(
      new Uint8Array(await response.arrayBuffer()),
      contentType,
    );
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
