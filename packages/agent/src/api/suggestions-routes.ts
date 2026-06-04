/**
 * POST /api/suggestions — model-generated tap-to-send prompt suggestions for
 * the continuous-chat overlay's resting composer strip.
 *
 * The client sends recent conversation context + the local hour; we ask the
 * small text model for EXACTLY 3 short, first-person prompts the user might tap
 * next, tailored to the character and the conversation so far. Generation
 * failures degrade gracefully to an empty list — the overlay keeps its static
 * offline fallback, so the strip is never empty.
 */

import type http from "node:http";
import {
  type AgentRuntime,
  ModelType,
  readRequestBodyBuffer,
} from "@elizaos/core";

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
}

export function parseRequestBody(raw: string): SuggestionsRequest {
  if (!raw.trim()) return { messages: [], hour: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { messages: [], hour: undefined };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { messages: [], hour: undefined };
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

  return { messages: messages.slice(-MAX_CONTEXT_MESSAGES), hour };
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

export async function handleSuggestionsRoutes(
  ctx: SuggestionsRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, json, error, runtime } = ctx;
  if (pathname !== "/api/suggestions") return false;
  if (method !== "POST") {
    error(res, "Method not allowed", 405);
    return true;
  }
  if (!runtime) {
    json(res, { suggestions: [] });
    return true;
  }

  const buffer = await readRequestBodyBuffer(req, {
    maxBytes: MAX_BODY_BYTES,
    returnNullOnTooLarge: true,
  });
  const request = parseRequestBody(buffer?.toString("utf8") ?? "");

  try {
    const raw = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: buildPrompt(runtime, request),
      maxTokens: 160,
      temperature: 0.8,
      responseFormat: { type: "json_object" },
    });
    const parsed = parseJsonObject(typeof raw === "string" ? raw : "");
    json(res, { suggestions: cleanSuggestions(parsed?.suggestions) });
  } catch (err) {
    runtime.logger.warn(
      {
        src: "api:suggestions",
        error: err instanceof Error ? err.message : String(err),
      },
      "Prompt suggestion generation failed; returning empty set",
    );
    json(res, { suggestions: [] });
  }
  return true;
}
