/**
 * Runtime validation for transcript view models crossing back from native
 * reducers. Capacitor and Electrobun return unknown JSON at the bridge boundary;
 * this decoder reconstructs the shared render shape before the product UI uses
 * it, so a malformed host response becomes an explicit invalid result.
 */

import type {
  AgentTranscriptItem,
  ErrorTranscriptItem,
  ReconnectTranscriptItem,
  SpeakingState,
  ToolTranscriptItem,
  TranscriptEventWord,
  TranscriptItem,
  TranscriptViewModel,
  UserTranscriptItem,
} from "./contract";

export interface TranscriptViewModelDecodeError {
  path: string;
  message: string;
}

export type TranscriptViewModelDecodeResult =
  | { ok: true; view: TranscriptViewModel }
  | { ok: false; error: TranscriptViewModelDecodeError };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(
  path: string,
  message: string,
): { ok: false; error: TranscriptViewModelDecodeError } {
  return { ok: false, error: { path, message } };
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readRequiredString(
  source: UnknownRecord,
  field: string,
  path: string,
  nonEmpty = false,
):
  | { ok: true; value: string }
  | { ok: false; error: TranscriptViewModelDecodeError } {
  const value = source[field];
  if (typeof value !== "string") {
    return invalid(`${path}.${field}`, "must be a string");
  }
  if (nonEmpty && value.length === 0) {
    return invalid(`${path}.${field}`, "must not be empty");
  }
  return { ok: true, value };
}

function readOptionalString(
  source: UnknownRecord,
  field: string,
  path: string,
  nonEmpty = false,
):
  | { ok: true; value: string | undefined }
  | { ok: false; error: TranscriptViewModelDecodeError } {
  if (!(field in source)) return { ok: true, value: undefined };
  const value = readRequiredString(source, field, path, nonEmpty);
  return value.ok ? { ok: true, value: value.value } : value;
}

function decodeWords(
  raw: unknown,
  path: string,
):
  | { ok: true; words: TranscriptEventWord[] }
  | { ok: false; error: TranscriptViewModelDecodeError } {
  if (!Array.isArray(raw)) return invalid(path, "must be an array");
  const words: TranscriptEventWord[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index];
    const wordPath = `${path}[${index}]`;
    if (!isRecord(value)) return invalid(wordPath, "must be an object");
    const text = readRequiredString(value, "text", wordPath);
    if (!text.ok) return text;
    const startMs = value.startMs;
    const endMs = value.endMs;
    if (
      typeof startMs !== "number" ||
      !Number.isFinite(startMs) ||
      startMs < 0
    ) {
      return invalid(
        `${wordPath}.startMs`,
        "must be a finite non-negative number",
      );
    }
    if (
      typeof endMs !== "number" ||
      !Number.isFinite(endMs) ||
      endMs < startMs
    ) {
      return invalid(
        `${wordPath}.endMs`,
        "must be finite and not precede startMs",
      );
    }
    words.push({ text: text.value, startMs, endMs });
  }
  return { ok: true, words };
}

function decodeUserItem(
  source: UnknownRecord,
  path: string,
):
  | { ok: true; item: UserTranscriptItem }
  | { ok: false; error: TranscriptViewModelDecodeError } {
  const id = readRequiredString(source, "id", path, true);
  if (!id.ok) return id;
  const text = readRequiredString(source, "text", path);
  if (!text.ok) return text;
  const status = source.status;
  if (status !== "partial" && status !== "final" && status !== "cancelled") {
    return invalid(`${path}.status`, "is not a user transcript status");
  }
  const words = decodeWords(source.words, `${path}.words`);
  if (!words.ok) return words;
  return {
    ok: true,
    item: {
      kind: "user",
      id: id.value,
      status,
      text: text.value,
      words: words.words,
    },
  };
}

function decodeAgentItem(
  source: UnknownRecord,
  path: string,
):
  | { ok: true; item: AgentTranscriptItem }
  | { ok: false; error: TranscriptViewModelDecodeError } {
  const id = readRequiredString(source, "id", path, true);
  if (!id.ok) return id;
  const text = readRequiredString(source, "text", path);
  if (!text.ok) return text;
  const turnId = readOptionalString(source, "turnId", path, true);
  if (!turnId.ok) return turnId;
  const status = source.status;
  if (status !== "streaming" && status !== "final" && status !== "cancelled") {
    return invalid(`${path}.status`, "is not an agent transcript status");
  }
  return {
    ok: true,
    item: {
      kind: "agent",
      id: id.value,
      status,
      text: text.value,
      ...(turnId.value === undefined ? {} : { turnId: turnId.value }),
    },
  };
}

function decodeToolItem(
  source: UnknownRecord,
  path: string,
):
  | { ok: true; item: ToolTranscriptItem }
  | { ok: false; error: TranscriptViewModelDecodeError } {
  const id = readRequiredString(source, "id", path, true);
  if (!id.ok) return id;
  const name = readRequiredString(source, "name", path, true);
  if (!name.ok) return name;
  const detail = readOptionalString(source, "detail", path);
  if (!detail.ok) return detail;
  const turnId = readOptionalString(source, "turnId", path, true);
  if (!turnId.ok) return turnId;
  const status = source.status;
  if (
    status !== "running" &&
    status !== "succeeded" &&
    status !== "failed" &&
    status !== "cancelled"
  ) {
    return invalid(`${path}.status`, "is not a tool transcript status");
  }
  return {
    ok: true,
    item: {
      kind: "tool",
      id: id.value,
      status,
      name: name.value,
      ...(detail.value === undefined ? {} : { detail: detail.value }),
      ...(turnId.value === undefined ? {} : { turnId: turnId.value }),
    },
  };
}

function decodeErrorItem(
  source: UnknownRecord,
  path: string,
):
  | { ok: true; item: ErrorTranscriptItem }
  | { ok: false; error: TranscriptViewModelDecodeError } {
  const id = readRequiredString(source, "id", path, true);
  if (!id.ok) return id;
  const code = readRequiredString(source, "code", path, true);
  if (!code.ok) return code;
  const message = readOptionalString(source, "message", path);
  if (!message.ok) return message;
  if (typeof source.retryable !== "boolean") {
    return invalid(`${path}.retryable`, "must be a boolean");
  }
  return {
    ok: true,
    item: {
      kind: "error",
      id: id.value,
      code: code.value,
      retryable: source.retryable,
      ...(message.value === undefined ? {} : { message: message.value }),
    },
  };
}

function decodeReconnectItem(
  source: UnknownRecord,
  path: string,
):
  | { ok: true; item: ReconnectTranscriptItem }
  | { ok: false; error: TranscriptViewModelDecodeError } {
  const id = readRequiredString(source, "id", path, true);
  if (!id.ok) return id;
  const phase = source.phase;
  if (phase !== "lost" && phase !== "restored") {
    return invalid(`${path}.phase`, "is not a reconnect phase");
  }
  if (!isSafeNonNegativeInteger(source.attempt)) {
    return invalid(`${path}.attempt`, "must be a safe non-negative integer");
  }
  return {
    ok: true,
    item: {
      kind: "reconnect",
      id: id.value,
      phase,
      attempt: source.attempt,
    },
  };
}

function decodeItem(
  raw: unknown,
  index: number,
):
  | { ok: true; item: TranscriptItem }
  | { ok: false; error: TranscriptViewModelDecodeError } {
  const path = `view.items[${index}]`;
  if (!isRecord(raw)) return invalid(path, "must be an object");
  switch (raw.kind) {
    case "user":
      return decodeUserItem(raw, path);
    case "agent":
      return decodeAgentItem(raw, path);
    case "tool":
      return decodeToolItem(raw, path);
    case "error":
      return decodeErrorItem(raw, path);
    case "reconnect":
      return decodeReconnectItem(raw, path);
    default:
      return invalid(`${path}.kind`, "is not a transcript item kind");
  }
}

function decodeSpeaking(
  raw: unknown,
):
  | { ok: true; speaking: SpeakingState | null }
  | { ok: false; error: TranscriptViewModelDecodeError } {
  if (raw === null) return { ok: true, speaking: null };
  if (!isRecord(raw))
    return invalid("view.speaking", "must be an object or null");
  const utteranceId = readRequiredString(
    raw,
    "utteranceId",
    "view.speaking",
    true,
  );
  if (!utteranceId.ok) return utteranceId;
  const messageId = readOptionalString(raw, "messageId", "view.speaking", true);
  if (!messageId.ok) return messageId;
  return {
    ok: true,
    speaking: {
      utteranceId: utteranceId.value,
      ...(messageId.value === undefined ? {} : { messageId: messageId.value }),
    },
  };
}

/** Validate an unknown native bridge response into the shared render model. */
export function decodeTranscriptViewModel(
  raw: unknown,
): TranscriptViewModelDecodeResult {
  if (!isRecord(raw)) return invalid("view", "must be an object");
  if (!Array.isArray(raw.items))
    return invalid("view.items", "must be an array");

  const items: TranscriptItem[] = [];
  for (let index = 0; index < raw.items.length; index += 1) {
    const decoded = decodeItem(raw.items[index], index);
    if (!decoded.ok) return decoded;
    items.push(decoded.item);
  }

  const speaking = decodeSpeaking(raw.speaking);
  if (!speaking.ok) return speaking;
  if (raw.connection !== "live" && raw.connection !== "lost") {
    return invalid("view.connection", "is not a connection state");
  }
  if (!isSafeNonNegativeInteger(raw.lastSeq)) {
    return invalid("view.lastSeq", "must be a safe non-negative integer");
  }

  return {
    ok: true,
    view: {
      items,
      speaking: speaking.speaking,
      connection: raw.connection,
      lastSeq: raw.lastSeq,
    },
  };
}
