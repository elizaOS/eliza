/**
 * POST /api/suggestions — server-tailored tap-to-send prompt suggestions for
 * the continuous-chat overlay's resting composer strip (#8225).
 *
 * The client sends recent conversation context, the local hour, and the
 * active page scope ("page-wallet", "page-browser", …). Two tiers:
 *
 * - `model`     — the small text model writes EXACTLY 3 short, first-person
 *                 prompts tailored to the character, the conversation, and
 *                 the active view.
 * - `heuristic` — a deterministic, zero-model-call set derived from scope +
 *                 thread state + time of day. Served when no runtime/model
 *                 is available or generation fails, and used to pad a short
 *                 model set — the response is never empty
 *                 (degrade-not-empty).
 *
 * Response: `{ suggestions: string[3], tier: "model" | "heuristic",
 * generatedAt: ISO }`. Clients that only read `suggestions` keep working.
 */

import type http from "node:http";
import {
  type AgentRuntime,
  ModelType,
  readRequestBodyBuffer,
} from "@elizaos/core";
import { isPageScope } from "@elizaos/shared/contracts";

const MAX_BODY_BYTES = 16 * 1024;
const SUGGESTION_COUNT = 3;
const MAX_SUGGESTION_CHARS = 48;
const MIN_SUGGESTION_CHARS = 2;
const MAX_CONTEXT_MESSAGES = 6;
const MAX_CONTEXT_CHARS = 240;

export interface SuggestionsRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  runtime: AgentRuntime | null | undefined;
}

interface ContextMessage {
  role: "user" | "assistant";
  content: string;
}

interface SuggestionsRequest {
  messages: ContextMessage[];
  hour: number | undefined;
  scope: string | undefined;
}

const EMPTY_REQUEST: SuggestionsRequest = {
  messages: [],
  hour: undefined,
  scope: undefined,
};

export function parseRequestBody(raw: string): SuggestionsRequest {
  if (!raw.trim()) return { ...EMPTY_REQUEST };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_REQUEST };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...EMPTY_REQUEST };
  }
  const body = parsed as Record<string, unknown>;

  const messages: ContextMessage[] = [];
  if (Array.isArray(body.messages)) {
    for (const entry of body.messages) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const role = record.role === "assistant" ? "assistant" : "user";
      const content =
        typeof record.content === "string" ? record.content.trim() : "";
      if (!content) continue;
      messages.push({ role, content: content.slice(0, MAX_CONTEXT_CHARS) });
    }
  }

  const hourValue = body.hour;
  const hour =
    typeof hourValue === "number" &&
    Number.isFinite(hourValue) &&
    hourValue >= 0 &&
    hourValue <= 23
      ? Math.floor(hourValue)
      : undefined;

  const scope = isPageScope(body.scope) ? body.scope : undefined;

  return { messages: messages.slice(-MAX_CONTEXT_MESSAGES), hour, scope };
}

// ---------------------------------------------------------------------------
// Heuristic tier — deterministic, zero model calls (#8225 Phase-1)
// ---------------------------------------------------------------------------

/** Per-scope starters; each obeys the same 2–6-word, ≤48-char suggestion rules. */
const SCOPE_STARTERS: Record<string, readonly string[]> = {
  "page-browser": [
    "Summarize this page",
    "Search the web for me",
    "Find sources for this",
  ],
  "page-character": [
    "Tune your personality",
    "Change your voice",
    "What can you do?",
  ],
  "page-automations": [
    "Create a daily routine",
    "List my automations",
    "What ran today?",
  ],
  // "What apps do I have?" is served by the LIST_CLOUD_APPS action
  // (@elizaos/plugin-cloud-apps) — its WHAT_APPS_DO_I_HAVE / MY_APPS similes
  // match this exact phrase, so clicking the chip lists the user's Cloud apps.
  "page-apps": ["What apps do I have?", "Recommend an app", "Build me an app"],
  "page-connectors": [
    "Check my connections",
    "Connect a new service",
    "Any connector errors?",
  ],
  "page-phone": ["Call a contact", "Read my messages", "Text someone for me"],
  "page-plugins": [
    "What plugins are active?",
    "Suggest a plugin",
    "Configure a plugin",
  ],
  "page-settings": [
    "Review my settings",
    "Switch my model",
    "Tighten my privacy",
  ],
  "page-wallet": ["Check my balance", "Recent transactions", "Send a payment"],
};

const GENERAL_STARTERS: readonly string[] = [
  "What can you do?",
  "Summarize my day",
  "Draft a reply",
  "What's on my plate?",
  "Explain this for me",
];

const THREAD_FOLLOW_UP = "Continue where we left off";

function heuristicLead(hour: number | undefined): string {
  if (hour === undefined) return GENERAL_STARTERS[0];
  if (hour >= 5 && hour < 12) return "Plan my day";
  if (hour >= 12 && hour < 18) return "What's left today?";
  return "Recap my day";
}

/**
 * Deterministic suggestions from scope + thread state + time of day. Always
 * returns exactly {@link SUGGESTION_COUNT} unique items — the
 * degrade-not-empty floor under the model tier.
 */
export function computeHeuristicSuggestions(
  request: SuggestionsRequest,
): string[] {
  const hasThread = request.messages.length > 0;
  const lead = hasThread ? THREAD_FOLLOW_UP : heuristicLead(request.hour);
  const scoped = (request.scope && SCOPE_STARTERS[request.scope]) || [];
  return Array.from(new Set([lead, ...scoped, ...GENERAL_STARTERS])).slice(
    0,
    SUGGESTION_COUNT,
  );
}

function timeOfDay(hour: number | undefined): string {
  if (hour === undefined) return "right now";
  if (hour >= 5 && hour < 12) return "this morning";
  if (hour >= 12 && hour < 18) return "this afternoon";
  if (hour >= 18 && hour < 22) return "this evening";
  return "tonight";
}

function characterHint(runtime: AgentRuntime): string {
  const name = runtime.character?.name?.trim() || "the assistant";
  const bioRaw = runtime.character?.bio;
  const bio = Array.isArray(bioRaw)
    ? bioRaw.join(" ")
    : typeof bioRaw === "string"
      ? bioRaw
      : "";
  const trimmedBio = bio.trim().slice(0, 240);
  return trimmedBio
    ? `The assistant is ${name}: ${trimmedBio}`
    : `The assistant is ${name}.`;
}

function buildPrompt(
  runtime: AgentRuntime,
  request: SuggestionsRequest,
): string {
  const conversation = request.messages.length
    ? request.messages
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n")
    : "No conversation yet.";

  // "page-wallet" → "wallet" — a human-readable view name for the prompt.
  const viewName = request.scope?.replace(/^page-/, "");

  return [
    `You write tap-to-send prompt suggestions for a chat composer. ${characterHint(runtime)}`,
    "",
    `Return JSON only, exactly this shape with EXACTLY ${SUGGESTION_COUNT} items:`,
    '{"suggestions":["...","...","..."]}',
    "",
    "Each suggestion is the NEXT thing the user might say to the assistant,",
    "written in first person from the user's point of view.",
    "Rules:",
    "- 2 to 6 words. Imperative or a short question. No trailing punctuation except '?'.",
    "- Concrete and immediately useful. No greetings, no 'hello', no emoji.",
    "- Do not number them, quote them, or add bullets inside the strings.",
    `- If a conversation is present, suggest natural follow-ups to it; otherwise offer broadly useful first moves for ${timeOfDay(request.hour)}.`,
    ...(viewName
      ? [
          `- The user is currently on the "${viewName}" view of the app; bias at least one suggestion toward what they'd do there.`,
        ]
      : []),
    "",
    "Conversation so far:",
    conversation,
  ].join("\n");
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const attempt = (candidate: string): Record<string, unknown> | null => {
    try {
      const value = JSON.parse(candidate);
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const direct = attempt(trimmed);
  if (direct) return direct;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return attempt(trimmed.slice(start, end + 1));
}

export function cleanSuggestions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const cleaned = raw
      .replace(/^\s*[-*\d.)\]]+\s*/, "") // leading bullet / "1." / "2)"
      .replace(/^["'`]+|["'`]+$/g, "") // wrapping quotes
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length < MIN_SUGGESTION_CHARS) continue;
    if (cleaned.length > MAX_SUGGESTION_CHARS) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= SUGGESTION_COUNT) break;
  }
  return out;
}

interface SuggestionsPayload {
  suggestions: string[];
  tier: "model" | "heuristic";
  generatedAt: string;
}

/** Pad a (possibly short) model set up to the full count from the heuristic tier. */
function padWithHeuristics(
  modelSuggestions: string[],
  request: SuggestionsRequest,
): SuggestionsPayload {
  const seen = new Set(modelSuggestions.map((s) => s.toLowerCase()));
  const padded = [...modelSuggestions];
  for (const candidate of computeHeuristicSuggestions(request)) {
    if (padded.length >= SUGGESTION_COUNT) break;
    if (seen.has(candidate.toLowerCase())) continue;
    seen.add(candidate.toLowerCase());
    padded.push(candidate);
  }
  return {
    suggestions: padded.slice(0, SUGGESTION_COUNT),
    tier: modelSuggestions.length > 0 ? "model" : "heuristic",
    generatedAt: new Date().toISOString(),
  };
}

export async function handleSuggestionsRoutes(
  ctx: SuggestionsRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, json, error, runtime } = ctx;
  if (pathname !== "/api/suggestions") return false;
  if (method !== "POST") {
    error(res, "Method not allowed", 405);
    return true;
  }

  const buffer = await readRequestBodyBuffer(req, {
    maxBytes: MAX_BODY_BYTES,
    returnNullOnTooLarge: true,
  });
  const request = parseRequestBody(buffer?.toString("utf8") ?? "");

  // No runtime → serve the deterministic tier (degrade-not-empty, #8225).
  if (!runtime) {
    json(res, padWithHeuristics([], request));
    return true;
  }

  try {
    const raw = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: buildPrompt(runtime, request),
      maxTokens: 160,
      temperature: 0.8,
      responseFormat: { type: "json_object" },
    });
    const parsed = parseJsonObject(typeof raw === "string" ? raw : "");
    json(
      res,
      padWithHeuristics(cleanSuggestions(parsed?.suggestions), request),
    );
  } catch (err) {
    runtime.logger.warn(
      {
        src: "api:suggestions",
        error: err instanceof Error ? err.message : String(err),
      },
      "Prompt suggestion generation failed; serving heuristic tier",
    );
    json(res, padWithHeuristics([], request));
  }
  return true;
}
