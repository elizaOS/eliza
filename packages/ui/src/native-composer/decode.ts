/**
 * Boundary decoder for `eliza.native-composer/v1`. Every field of an untrusted
 * operation (or the attachment source it carries) is validated here before it
 * reaches the reducer, so `reduce.ts` trusts its input completely and never
 * re-checks shapes.
 *
 * A malformed operation yields an explicit typed failure (`{ ok: false, error }`),
 * never a fabricated-valid default and never a throw — one bad frame from a
 * native bridge must not tear down a live composer session (error-policy J3:
 * untrusted-input sanitizing produces an explicit "invalid" result).
 * `decodeComposerOperationStream` applies the same rule per operation: valid ops
 * accumulate, malformed ones are collected with their index and reason.
 *
 * The attachment-source decoder is exported on its own because the server-side
 * store-ingest boundary decodes the SAME wire bytes independently (the contract
 * is language-neutral; each consumer validates at its own edge), and because it
 * structurally rejects any second-file-store shape — only the four
 * media-store-vocabulary sources decode.
 */

import {
  type ComposerAttachmentSource,
  type ComposerMention,
  type ComposerOperation,
  type ComposerReplyContext,
  NATIVE_COMPOSER_SCHEMA,
} from "./contract";

/** Machine-readable reason a raw value failed to decode. */
export type ComposerDecodeErrorCode =
  | "not-an-object"
  | "unknown-type"
  | "missing-field"
  | "invalid-field";

export interface ComposerDecodeError {
  code: ComposerDecodeErrorCode;
  /** The offending field, when the failure is field-specific. */
  field?: string;
  message: string;
}

export type ComposerOperationDecodeResult =
  | { ok: true; operation: ComposerOperation }
  | { ok: false; error: ComposerDecodeError };

export type ComposerAttachmentDecodeResult =
  | { ok: true; attachment: ComposerAttachmentSource }
  | { ok: false; error: ComposerDecodeError };

function fail(
  code: ComposerDecodeErrorCode,
  message: string,
  field?: string,
): { ok: false; error: ComposerDecodeError } {
  return { ok: false, error: { code, field, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** `at` is optional display metadata; when present it must be a finite number. */
function optionalTimestampInvalid(record: Record<string, unknown>): boolean {
  return "at" in record && !isFiniteNumber(record.at);
}

/** An optional field is valid iff it is absent/undefined or a non-empty string. */
function optionalStringInvalid(
  record: Record<string, unknown>,
  key: string,
): boolean {
  return (
    key in record && record[key] !== undefined && !isNonEmptyString(record[key])
  );
}

/**
 * Validate one raw value into a typed {@link ComposerAttachmentSource}. Only the
 * four media-store sources decode; an unknown `source` (including any
 * file-id/second-store shape) is rejected. Unknown extra keys are ignored for
 * forward compatibility.
 */
export function decodeComposerAttachmentSource(
  raw: unknown,
): ComposerAttachmentDecodeResult {
  if (!isRecord(raw)) {
    return fail("not-an-object", "attachment must be a non-null object");
  }
  const source = raw.source;
  if (typeof source !== "string") {
    return fail(
      "missing-field",
      "attachment is missing a string `source`",
      "source",
    );
  }
  if (optionalStringInvalid(raw, "name")) {
    return fail("invalid-field", "`name` must be a non-empty string", "name");
  }
  switch (source) {
    case "inline": {
      if (!isNonEmptyString(raw.mimeType))
        return fail("missing-field", "`mimeType` is required", "mimeType");
      if (!isNonEmptyString(raw.bytesBase64))
        return fail(
          "missing-field",
          "`bytesBase64` is required",
          "bytesBase64",
        );
      return {
        ok: true,
        attachment: {
          source,
          mimeType: raw.mimeType,
          bytesBase64: raw.bytesBase64,
          ...(isNonEmptyString(raw.name) ? { name: raw.name } : {}),
        },
      };
    }
    case "data-url": {
      if (!isNonEmptyString(raw.dataUrl) || !raw.dataUrl.startsWith("data:"))
        return fail(
          "invalid-field",
          "`dataUrl` must be a data: URL string",
          "dataUrl",
        );
      return {
        ok: true,
        attachment: {
          source,
          dataUrl: raw.dataUrl,
          ...(isNonEmptyString(raw.name) ? { name: raw.name } : {}),
        },
      };
    }
    case "remote": {
      if (!isNonEmptyString(raw.url))
        return fail("missing-field", "`url` is required", "url");
      if (optionalStringInvalid(raw, "mimeType"))
        return fail("invalid-field", "`mimeType` must be a string", "mimeType");
      return {
        ok: true,
        attachment: {
          source,
          url: raw.url,
          ...(isNonEmptyString(raw.mimeType) ? { mimeType: raw.mimeType } : {}),
          ...(isNonEmptyString(raw.name) ? { name: raw.name } : {}),
        },
      };
    }
    case "stored": {
      if (!isNonEmptyString(raw.url))
        return fail("missing-field", "`url` is required", "url");
      if (optionalStringInvalid(raw, "mimeType"))
        return fail("invalid-field", "`mimeType` must be a string", "mimeType");
      return {
        ok: true,
        attachment: {
          source,
          url: raw.url,
          ...(isNonEmptyString(raw.mimeType) ? { mimeType: raw.mimeType } : {}),
          ...(isNonEmptyString(raw.name) ? { name: raw.name } : {}),
        },
      };
    }
    default:
      return fail(
        "invalid-field",
        `unknown attachment source: ${source}`,
        "source",
      );
  }
}

function decodeReplyContext(
  raw: unknown,
): { ok: true; reply: ComposerReplyContext } | { ok: false; field: string } {
  if (!isRecord(raw)) return { ok: false, field: "reply" };
  if (!isNonEmptyString(raw.messageId))
    return { ok: false, field: "reply.messageId" };
  if (optionalStringInvalid(raw, "authorId"))
    return { ok: false, field: "reply.authorId" };
  if (
    "preview" in raw &&
    raw.preview !== undefined &&
    typeof raw.preview !== "string"
  )
    return { ok: false, field: "reply.preview" };
  return {
    ok: true,
    reply: {
      messageId: raw.messageId,
      ...(isNonEmptyString(raw.authorId) ? { authorId: raw.authorId } : {}),
      ...(typeof raw.preview === "string" ? { preview: raw.preview } : {}),
    },
  };
}

function decodeMention(
  raw: unknown,
): { ok: true; mention: ComposerMention } | { ok: false; field: string } {
  if (!isRecord(raw)) return { ok: false, field: "mention" };
  if (!isNonEmptyString(raw.id)) return { ok: false, field: "mention.id" };
  if (typeof raw.label !== "string")
    return { ok: false, field: "mention.label" };
  if (
    "kind" in raw &&
    raw.kind !== undefined &&
    raw.kind !== "user" &&
    raw.kind !== "agent" &&
    raw.kind !== "channel"
  )
    return { ok: false, field: "mention.kind" };
  return {
    ok: true,
    mention: {
      id: raw.id,
      label: raw.label,
      ...(raw.kind === "user" || raw.kind === "agent" || raw.kind === "channel"
        ? { kind: raw.kind }
        : {}),
    },
  };
}

/**
 * Validate one raw value into a typed {@link ComposerOperation}. Every op must
 * carry a non-empty `opId` (the idempotency key) and a known `type`; per-type
 * fields are then checked. Unknown extra keys are ignored (forward compat).
 */
export function decodeComposerOperation(
  raw: unknown,
): ComposerOperationDecodeResult {
  if (!isRecord(raw)) {
    return fail("not-an-object", "operation must be a non-null object");
  }
  const type = raw.type;
  if (typeof type !== "string") {
    return fail(
      "missing-field",
      "operation is missing a string `type`",
      "type",
    );
  }
  if (!isNonEmptyString(raw.opId)) {
    return fail(
      "missing-field",
      "`opId` is required (idempotency key)",
      "opId",
    );
  }
  if (optionalTimestampInvalid(raw)) {
    return fail("invalid-field", "`at` must be a finite number", "at");
  }
  const opId = raw.opId;
  const at = isFiniteNumber(raw.at) ? { at: raw.at } : {};

  switch (type) {
    case "text.insert":
    case "text.set": {
      if (typeof raw.text !== "string")
        return fail("invalid-field", "`text` must be a string", "text");
      return { ok: true, operation: { type, opId, text: raw.text, ...at } };
    }
    case "attachment.add": {
      if (!isNonEmptyString(raw.attachmentId))
        return fail(
          "missing-field",
          "`attachmentId` is required",
          "attachmentId",
        );
      const decoded = decodeComposerAttachmentSource(raw.attachment);
      if (!decoded.ok) return decoded;
      return {
        ok: true,
        operation: {
          type,
          opId,
          attachmentId: raw.attachmentId,
          attachment: decoded.attachment,
          ...at,
        },
      };
    }
    case "attachment.remove": {
      if (!isNonEmptyString(raw.attachmentId))
        return fail(
          "missing-field",
          "`attachmentId` is required",
          "attachmentId",
        );
      return {
        ok: true,
        operation: { type, opId, attachmentId: raw.attachmentId, ...at },
      };
    }
    case "reply.set": {
      const decoded = decodeReplyContext(raw.reply);
      if (!decoded.ok)
        return fail("invalid-field", "`reply` is malformed", decoded.field);
      return {
        ok: true,
        operation: { type, opId, reply: decoded.reply, ...at },
      };
    }
    case "reply.clear": {
      return { ok: true, operation: { type, opId, ...at } };
    }
    case "mention.add": {
      const decoded = decodeMention(raw.mention);
      if (!decoded.ok)
        return fail("invalid-field", "`mention` is malformed", decoded.field);
      return {
        ok: true,
        operation: { type, opId, mention: decoded.mention, ...at },
      };
    }
    case "send": {
      return { ok: true, operation: { type, opId, ...at } };
    }
    case "cancel": {
      if (raw.scope !== "send" && raw.scope !== "draft")
        return fail("invalid-field", "`scope` must be send|draft", "scope");
      return { ok: true, operation: { type, opId, scope: raw.scope, ...at } };
    }
    case "focus.set": {
      if (typeof raw.focused !== "boolean")
        return fail("invalid-field", "`focused` must be a boolean", "focused");
      if (
        "keyboard" in raw &&
        raw.keyboard !== undefined &&
        raw.keyboard !== "shown" &&
        raw.keyboard !== "hidden"
      )
        return fail(
          "invalid-field",
          "`keyboard` must be shown|hidden",
          "keyboard",
        );
      return {
        ok: true,
        operation: {
          type,
          opId,
          focused: raw.focused,
          ...(raw.keyboard === "shown" || raw.keyboard === "hidden"
            ? { keyboard: raw.keyboard }
            : {}),
          ...at,
        },
      };
    }
    case "voice.handoff": {
      if (
        raw.phase !== "start" &&
        raw.phase !== "commit" &&
        raw.phase !== "cancel"
      )
        return fail(
          "invalid-field",
          "`phase` must be start|commit|cancel",
          "phase",
        );
      if (
        "transcript" in raw &&
        raw.transcript !== undefined &&
        typeof raw.transcript !== "string"
      )
        return fail(
          "invalid-field",
          "`transcript` must be a string",
          "transcript",
        );
      return {
        ok: true,
        operation: {
          type,
          opId,
          phase: raw.phase,
          ...(typeof raw.transcript === "string"
            ? { transcript: raw.transcript }
            : {}),
          ...at,
        },
      };
    }
    default:
      return fail("unknown-type", `unknown operation type: ${type}`, "type");
  }
}

export interface ComposerStreamDecodeResult {
  /** Operations that passed validation, in the order they appeared. */
  operations: ComposerOperation[];
  /** Malformed ops with their source index and reason (never silently lost). */
  rejected: { index: number; error: ComposerDecodeError }[];
}

/**
 * Decode a stream envelope `{ schema, operations }`. Throws only when the
 * envelope itself is unusable (not an object, wrong/absent schema tag) — that is
 * a programming/version error, not untrusted per-op input. Per-op failures are
 * returned in `rejected`, never thrown, so a mixed batch still yields its good
 * operations.
 */
export function decodeComposerOperationStream(
  raw: unknown,
): ComposerStreamDecodeResult {
  if (!isRecord(raw)) {
    throw new TypeError(
      "[decodeComposerOperationStream] stream must be a { schema, operations } object",
    );
  }
  if (raw.schema !== NATIVE_COMPOSER_SCHEMA) {
    throw new TypeError(
      `[decodeComposerOperationStream] unsupported schema: ${String(raw.schema)}`,
    );
  }
  if (!Array.isArray(raw.operations)) {
    throw new TypeError(
      "[decodeComposerOperationStream] `operations` must be an array",
    );
  }
  const operations: ComposerOperation[] = [];
  const rejected: { index: number; error: ComposerDecodeError }[] = [];
  raw.operations.forEach((rawOp, index) => {
    const decoded = decodeComposerOperation(rawOp);
    if (decoded.ok) operations.push(decoded.operation);
    else rejected.push({ index, error: decoded.error });
  });
  return { operations, rejected };
}
