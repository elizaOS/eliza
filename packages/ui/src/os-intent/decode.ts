/**
 * Boundary decoder for the OS-intent vocabulary. Everything that arrives from
 * outside the app — a native bridge speaking the vocabulary, an `elizaos://…`
 * deep link, a notification tap, the legacy assistant-launch payload — is
 * validated here into a typed {@link OsIntent} before it reaches the router, so
 * `router.ts` trusts its input completely.
 *
 * A malformed input yields an explicit typed failure (`{ ok: false, error }`),
 * never a fabricated-valid default and never a throw (error-policy J3:
 * untrusted-input sanitizing produces an explicit "invalid" result). The
 * deep-link/legacy adapters are where the historical free-form `action` string
 * (`ask`/`chat`/`voice`/…) is mapped to a typed intent — the ONE place that
 * string is interpreted; structural routing downstream never sees it. An input
 * this app does not own (a `feature`/`lifeops` deep link) returns
 * `unrecognized-launch` so the caller keeps its existing routing rather than
 * having it forced into this vocabulary.
 */

import type { ImageAttachment } from "../api/client-types-chat";
import {
  ASSISTANT_LAUNCH_TEXT_KEYS,
  type AssistantLaunchPayload,
} from "../platform/assistant-launch-payload";
import {
  INTENT_SOURCES,
  type IntentSource,
  OS_INTENT_TYPES,
  type OsIntent,
  type OsIntentType,
} from "./contract";

/** Machine-readable reason a raw input failed to decode. */
export type IntentDecodeErrorCode =
  | "not-an-object"
  | "unknown-type"
  | "unknown-source"
  | "missing-field"
  | "invalid-field"
  | "not-a-url"
  | "unrecognized-launch";

export interface IntentDecodeError {
  code: IntentDecodeErrorCode;
  /** The offending field, when the failure is field-specific. */
  field?: string;
  message: string;
}

export type IntentDecodeResult =
  | { ok: true; intent: OsIntent }
  | { ok: false; error: IntentDecodeError };

function fail(
  code: IntentDecodeErrorCode,
  message: string,
  field?: string,
): { ok: false; error: IntentDecodeError } {
  return { ok: false, error: { code, field, message } };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageAttachment(value: unknown): value is ImageAttachment {
  if (!isRecord(value)) return false;
  const thumbnail = value.thumbnail;
  return (
    typeof value.data === "string" &&
    value.data.length <= 32_000_000 &&
    typeof value.mimeType === "string" &&
    value.mimeType.length > 0 &&
    value.mimeType.length <= 256 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 2_000 &&
    (value.transcriptId === undefined ||
      (typeof value.transcriptId === "string" &&
        value.transcriptId.length > 0)) &&
    (thumbnail === undefined ||
      (isRecord(thumbnail) &&
        typeof thumbnail.data === "string" &&
        thumbnail.data.length <= 32_000_000 &&
        typeof thumbnail.mimeType === "string" &&
        thumbnail.mimeType.length > 0 &&
        thumbnail.mimeType.length <= 256))
  );
}

const INTENT_TYPE_SET: ReadonlySet<string> = new Set(OS_INTENT_TYPES);
const INTENT_SOURCE_SET: ReadonlySet<string> = new Set(INTENT_SOURCES);

function isIntentSource(value: unknown): value is IntentSource {
  return typeof value === "string" && INTENT_SOURCE_SET.has(value);
}

/**
 * Validate a raw value already shaped as an intent (a native bridge that speaks
 * the vocabulary directly). Unknown keys are ignored (forward compatibility);
 * every known field is type-checked and the per-type required fields enforced.
 */
export function decodeOsIntent(raw: unknown): IntentDecodeResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("not-an-object", "intent must be a non-null object");
  }
  const record = raw as Record<string, unknown>;

  const type = record.type;
  if (typeof type !== "string") {
    return fail("missing-field", "intent is missing a string `type`", "type");
  }
  if (!INTENT_TYPE_SET.has(type)) {
    return fail("unknown-type", `unknown intent type: ${type}`, "type");
  }
  if (!isNonEmptyString(record.intentId)) {
    return fail("missing-field", "`intentId` is required", "intentId");
  }
  if (!isIntentSource(record.source)) {
    return fail(
      "unknown-source",
      `unknown intent source: ${String(record.source)}`,
      "source",
    );
  }
  let issuedAt: number | undefined;
  if ("issuedAt" in record && record.issuedAt !== undefined) {
    if (
      typeof record.issuedAt !== "number" ||
      !Number.isFinite(record.issuedAt)
    ) {
      return fail(
        "invalid-field",
        "`issuedAt` must be a finite number",
        "issuedAt",
      );
    }
    issuedAt = record.issuedAt;
  }

  const base = {
    intentId: record.intentId,
    source: record.source,
    ...(issuedAt !== undefined ? { issuedAt } : {}),
  };
  const intentType = type as OsIntentType;

  switch (intentType) {
    case "send": {
      if (typeof record.text !== "string") {
        return fail("invalid-field", "`text` must be a string", "text");
      }
      if (record.text.length === 0) {
        return fail(
          "missing-field",
          "`send` requires non-empty `text`",
          "text",
        );
      }
      if (
        "channelType" in record &&
        record.channelType !== undefined &&
        record.channelType !== "DM" &&
        record.channelType !== "VOICE_DM"
      ) {
        return fail(
          "invalid-field",
          "`channelType` must be DM|VOICE_DM",
          "channelType",
        );
      }
      if (
        "images" in record &&
        record.images !== undefined &&
        (!Array.isArray(record.images) ||
          record.images.length > 32 ||
          !record.images.every(isImageAttachment))
      ) {
        return fail(
          "invalid-field",
          "`images` must be an array of valid image attachments",
          "images",
        );
      }
      if (
        "metadata" in record &&
        record.metadata !== undefined &&
        !isRecord(record.metadata)
      ) {
        return fail(
          "invalid-field",
          "`metadata` must be an object",
          "metadata",
        );
      }
      return {
        ok: true,
        intent: {
          type: "send",
          ...base,
          text: record.text,
          ...(record.channelType === "DM" || record.channelType === "VOICE_DM"
            ? { channelType: record.channelType }
            : {}),
          ...(Array.isArray(record.images)
            ? { images: record.images as ImageAttachment[] }
            : {}),
          ...(isRecord(record.metadata) ? { metadata: record.metadata } : {}),
        },
      };
    }
    case "start-voice": {
      if (record.mode !== "converse" && record.mode !== "dictate") {
        return fail("invalid-field", "`mode` must be converse|dictate", "mode");
      }
      return {
        ok: true,
        intent: { type: "start-voice", ...base, mode: record.mode },
      };
    }
    case "open-chat":
    case "stop-voice":
    case "start-transcription":
    case "stop-transcription":
    case "continue-conversation":
      return { ok: true, intent: { type: intentType, ...base } };
    default: {
      const _exhaustive: never = intentType;
      return _exhaustive;
    }
  }
}

/**
 * Map the resolved launch signals (host segment, `action`, `voice` flag, text)
 * to a typed intent type. Returns null when this app does not own the launch.
 * Precedence: voice/transcription/continue are recognized before the chat
 * defaults so an explicit `voice=1` or `action=voice` wins over a `chat` host.
 */
function resolveLaunchIntentType(
  host: string,
  action: string,
  voiceFlag: boolean,
  hasText: boolean,
  source: IntentSource,
): OsIntentType | null {
  if (action === "stop-transcription" || action === "stop-transcribe") {
    return "stop-transcription";
  }
  if (action === "stop-voice") return "stop-voice";
  if (source === "ios-live-activity") {
    if (action === "stop" || action === "save") return "stop-transcription";
    if (action === "open") return "continue-conversation";
  }
  if (voiceFlag || action === "voice" || host === "voice") return "start-voice";
  if (
    action === "transcribe" ||
    action === "transcription" ||
    action === "start-transcription" ||
    host === "transcribe"
  ) {
    return "start-transcription";
  }
  if (action === "continue" || action === "resume" || host === "continue") {
    return "continue-conversation";
  }
  if (action === "ask" || action === "smart-reply" || action === "send") {
    return hasText ? "send" : "open-chat";
  }
  if (
    action === "lifeops.create" ||
    action === "lifeops.daily-brief" ||
    action === "lifeops.tasks"
  ) {
    return hasText ? "send" : "open-chat";
  }
  if (action === "chat" || host === "chat" || host === "assistant") {
    return hasText ? "send" : "open-chat";
  }
  return null;
}

function readLaunchText(params: URLSearchParams): string {
  for (const key of ASSISTANT_LAUNCH_TEXT_KEYS) {
    const value = params.get(key)?.trim();
    if (value) return value;
  }
  return "";
}

function buildLaunchIntent(
  intentType: OsIntentType,
  source: IntentSource,
  intentId: string,
  text: string,
  issuedAt?: number,
): OsIntent {
  const base = {
    intentId,
    source,
    ...(issuedAt !== undefined ? { issuedAt } : {}),
  };
  switch (intentType) {
    case "send":
      return { type: "send", ...base, text };
    case "start-voice":
      return { type: "start-voice", ...base, mode: "converse" };
    case "open-chat":
    case "stop-voice":
    case "start-transcription":
    case "stop-transcription":
    case "continue-conversation":
      return { type: intentType, ...base };
    default: {
      const _exhaustive: never = intentType;
      return _exhaustive;
    }
  }
}

/**
 * Decode an `elizaos://…?source=…&action=…&text=…&voice=1` launch link into a
 * typed intent. Custom-scheme hosts are NOT lowercased by the URL parser, so the
 * host segment is normalized before matching (same gotcha as
 * `classifyDeepLinkRoute`). `intentId` is the explicit `assistant.launchId` when
 * present, else a stable synthesis so a redelivered identical link dedupes.
 */
export function decodeDeepLinkIntent(url: string): IntentDecodeResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail("not-a-url", `not a parseable URL: ${url}`);
  }

  const params = parsed.searchParams;
  const source = params.get("source")?.trim() ?? "";
  if (!isIntentSource(source)) {
    return fail(
      "unknown-source",
      `unknown or missing launch source: ${source || "(none)"}`,
      "source",
    );
  }

  const host = parsed.host.toLowerCase();
  const action = params.get("action")?.trim().toLowerCase() ?? "";
  const voiceFlag = params.get("voice")?.trim() === "1";
  const text = readLaunchText(params);
  const issuedAtRaw = params.get("issuedAt")?.trim();
  let issuedAt: number | undefined;
  if (issuedAtRaw) {
    issuedAt = Number(issuedAtRaw);
    if (!Number.isFinite(issuedAt)) {
      return fail("invalid-field", "`issuedAt` must be finite", "issuedAt");
    }
  }

  const intentType = resolveLaunchIntentType(
    host,
    action,
    voiceFlag,
    text.length > 0,
    source,
  );
  if (!intentType) {
    return fail(
      "unrecognized-launch",
      `deep link is not a chat/voice/transcription launch: ${url}`,
    );
  }

  const intentId =
    params.get("assistant.launchId")?.trim() ||
    `${source}:${host}:${action}:${text}`;

  return {
    ok: true,
    intent: buildLaunchIntent(intentType, source, intentId, text, issuedAt),
  };
}

/**
 * Adapt the legacy {@link AssistantLaunchPayload} (chat-only launch record) into
 * the unified vocabulary, so the existing consumer can route through the one
 * authority without re-parsing the deep link. The payload's `route` is the host
 * segment and its `launchId` is the dedupe identity.
 */
export function fromAssistantLaunchPayload(
  payload: AssistantLaunchPayload,
): IntentDecodeResult {
  if (!isIntentSource(payload.source)) {
    return fail(
      "unknown-source",
      `unknown launch source: ${payload.source}`,
      "source",
    );
  }
  const host = payload.route.toLowerCase();
  const action = (payload.action ?? "").toLowerCase();
  const text = payload.text.trim();

  const intentType = resolveLaunchIntentType(
    host,
    action,
    false,
    text.length > 0,
    payload.source,
  );
  if (!intentType) {
    return fail(
      "unrecognized-launch",
      `launch payload is not a chat/voice/transcription intent`,
    );
  }
  return {
    ok: true,
    intent: buildLaunchIntent(
      intentType,
      payload.source,
      payload.launchId,
      text,
    ),
  };
}
