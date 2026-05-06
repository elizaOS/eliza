/**
 * Web tools for the native reasoning loop.
 *
 *   - web_fetch  — GET a URL, strip <script>/<style>, return up to 50KB of text
 *   - web_search — Brave Search API (BRAVE_API_KEY), top N results as markdown
 */

import type { NativeTool, NativeToolHandler } from "../tool-schema.js";
import { truncate } from "./_safe-path.js";

const FETCH_BYTE_CAP = 50 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/* ──────────────────────────────────────────────────────────────────── *
 *  web_fetch                                                            *
 * ──────────────────────────────────────────────────────────────────── */

export interface WebFetchInput {
  url: string;
}

export const webFetchTool: NativeTool = {
  type: "custom",
  name: "web_fetch",
  description:
    "Fetch a URL and return its text content. HTML is stripped of " +
    "<script> and <style> blocks; result is capped at ~50KB.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string" },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

export const webFetchHandler: NativeToolHandler = async (rawInput) => {
  const input = (rawInput ?? {}) as Partial<WebFetchInput>;
  if (typeof input.url !== "string") {
    return { content: "web_fetch: 'url' is required", is_error: true };
  }
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return { content: `web_fetch: invalid URL: ${input.url}`, is_error: true };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      content: `web_fetch: unsupported scheme '${url.protocol}'`,
      is_error: true,
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "user-agent": "nyx-native-reasoning/0.1 (+https://milady.cloud)",
        accept: "text/html,application/xhtml+xml,text/plain,*/*;q=0.8",
      },
    });
    const ctype = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    const cleaned = ctype.includes("html") ? stripHtml(raw) : raw;
    const { text } = truncate(cleaned, FETCH_BYTE_CAP);
    const header = `[${res.status} ${res.statusText}] ${url.toString()}\n`;
    return {
      content: header + text,
      is_error: !res.ok,
    };
  } catch (err) {
    const e = err as Error;
    const reason =
      e.name === "AbortError" ? "request aborted (timeout?)" : e.message;
    return { content: `web_fetch: ${reason}`, is_error: true };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Strip <script> and <style> blocks, then collapse remaining tags to
 * whitespace-separated text. Not a full HTML→markdown converter — keep
 * it cheap and reliable.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ──────────────────────────────────────────────────────────────────── *
 *  web_search (Brave)                                                   *
 * ──────────────────────────────────────────────────────────────────── */

export interface WebSearchInput {
  query: string;
  count?: number;
}

export const webSearchTool: NativeTool = {
  type: "custom",
  name: "web_search",
  description:
    "Search the web via Brave Search. Returns the top N results as a " +
    "markdown list of {title, url, snippet}. Default N=5.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      count: {
        type: "number",
        description: "Number of results (1–10, default 5).",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}
interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

export const webSearchHandler: NativeToolHandler = async (rawInput) => {
  const input = (rawInput ?? {}) as Partial<WebSearchInput>;
  if (typeof input.query !== "string" || input.query.length === 0) {
    return { content: "web_search: 'query' is required", is_error: true };
  }
  const apiKey = process.env.BRAVE_API_KEY?.trim();
  if (!apiKey) {
    return {
      content: "web_search: BRAVE_API_KEY is not set; cannot search.",
      is_error: true,
    };
  }
  const count = Math.max(1, Math.min(10, input.count ?? 5));
  const u = new URL("https://api.search.brave.com/res/v1/web/search");
  u.searchParams.set("q", input.query);
  u.searchParams.set("count", String(count));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(u, {
      signal: ctrl.signal,
      headers: {
        accept: "application/json",
        "x-subscription-token": apiKey,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        content: `web_search: ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
        is_error: true,
      };
    }
    const data = (await res.json()) as BraveResponse;
    const results = data.web?.results ?? [];
    if (results.length === 0) return { content: "(no results)" };
    const md = results
      .slice(0, count)
      .map((r, i) => {
        const title = r.title ?? "(untitled)";
        const url = r.url ?? "";
        const snippet = (r.description ?? "").replace(/\s+/g, " ").trim();
        return `${i + 1}. [${title}](${url})\n   ${snippet}`;
      })
      .join("\n");
    return { content: md };
  } catch (err) {
    const e = err as Error;
    const reason =
      e.name === "AbortError" ? "request aborted (timeout?)" : e.message;
    return { content: `web_search: ${reason}`, is_error: true };
  } finally {
    clearTimeout(timer);
  }
};
