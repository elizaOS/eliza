import {
  type Action,
  type ActionResult,
  logger as coreLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";

import {
  failureToActionResult,
  readStringParam,
  successActionResult,
} from "../lib/format.js";
import { CODING_TOOLS_CONTEXTS, CODING_TOOLS_LOG_PREFIX } from "../types.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 50_000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(h)) return true;
  // 169.254.0.0/16 — link-local IPv4.
  if (h.startsWith("169.254.")) return true;
  return false;
}

function isTruthySetting(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === 1;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const webFetchAction: Action = {
  name: "WEB_FETCH",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: ["code", "terminal", "automation"] },
  roleGate: { minRole: "ADMIN" },
  similes: ["FETCH_URL", "GET_URL", "DOWNLOAD_PAGE"],
  description:
    "Fetch a single http(s) URL and return its body as text. HTML responses are stripped of tags and collapsed to plain text. Body is capped at 5MB; text is capped at 50000 chars. Loopback addresses (localhost, 127.0.0.1, 0.0.0.0, ::1, 169.254.*) are blocked by default; set CODING_TOOLS_WEB_FETCH_ALLOW_LOOPBACK=1 to permit them. Use for reading documentation, blog posts, or pasting in a URL the user referenced.",
  descriptionCompressed:
    "Fetch http(s) URL and return body as plain text (HTML stripped, capped).",
  parameters: [
    {
      name: "url",
      description: "Absolute http:// or https:// URL to fetch.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "prompt",
      description:
        "Optional summary/extraction instruction. Echoed verbatim in the result text; no LLM is run on the body in v1.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ) => {
    return typeof fetch === "function";
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const rawUrl = readStringParam(options, "url");
    if (!rawUrl) {
      return failureToActionResult({
        reason: "missing_param",
        message: "url is required",
      });
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return failureToActionResult({
        reason: "invalid_param",
        message: `not a valid URL: ${rawUrl}`,
      });
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return failureToActionResult({
        reason: "invalid_param",
        message: `unsupported protocol: ${parsed.protocol} (only http: and https: are allowed)`,
      });
    }

    const allowLoopback = isTruthySetting(
      runtime.getSetting?.("CODING_TOOLS_WEB_FETCH_ALLOW_LOOPBACK"),
    );
    if (!allowLoopback && isLoopbackHostname(parsed.hostname)) {
      return failureToActionResult({
        reason: "path_blocked",
        message: `loopback/link-local host blocked: ${parsed.hostname}`,
      });
    }

    const promptParam = readStringParam(options, "prompt");

    let response: Response;
    try {
      response = await fetch(parsed.toString(), {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout =
        err instanceof Error &&
        (err.name === "TimeoutError" || err.name === "AbortError");
      return failureToActionResult({
        reason: isTimeout ? "timeout" : "io_error",
        message: `fetch failed: ${msg}`,
      });
    }

    if (!response.ok) {
      return failureToActionResult({
        reason: "io_error",
        message: `http ${response.status} ${response.statusText} for ${parsed.toString()}`,
      });
    }

    const reader = response.body?.getReader();
    let received = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        if (received > MAX_BODY_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // ignore — we're already failing.
          }
          return failureToActionResult({
            reason: "io_error",
            message: `response body exceeds ${MAX_BODY_BYTES} byte cap`,
          });
        }
        chunks.push(value);
      }
    }

    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const byteCount = buffer.byteLength;
    const raw = buffer.toString("utf8");

    const contentType = response.headers.get("content-type") ?? "";
    const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);
    const extracted = isHtml ? htmlToText(raw) : raw;

    const truncated = extracted.length > MAX_TEXT_CHARS;
    const body = truncated
      ? `${extracted.slice(0, MAX_TEXT_CHARS)}…[truncated]`
      : extracted;

    const finalUrl = response.url || parsed.toString();
    const promptSuffix =
      promptParam && promptParam.trim().length > 0
        ? `\n\nPrompt: ${promptParam}`
        : "";
    const text = `# ${finalUrl}\n\n${body}${promptSuffix}`;

    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} WEB_FETCH ${parsed.toString()} -> ${finalUrl} bytes=${byteCount} truncated=${truncated}`,
    );

    if (callback) await callback({ text, source: "coding-tools" });

    return successActionResult(text, {
      url: parsed.toString(),
      finalUrl,
      contentType,
      byteCount,
      truncated,
    });
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Fetch the changelog at https://example.com/CHANGELOG.md.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Fetching the URL.",
          actions: ["WEB_FETCH"],
          thought:
            "Direct URL retrieval maps to WEB_FETCH with the explicit url parameter.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Read https://example.com/api/status as JSON.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Fetching the API status.",
          actions: ["WEB_FETCH"],
          thought:
            "JSON endpoint; WEB_FETCH retrieves the body and the agent parses content-type from the response.",
        },
      },
    ],
  ],
};
