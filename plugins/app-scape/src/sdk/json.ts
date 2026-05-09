/**
 * Thin JSON adapter for the 'scape bot-SDK client.
 *
 * Wraps JSON serialization with helpers that mirror the xRSPS server's
 * `BotSdkCodec` shape — same structure, same error surface, so regressions on
 * either side are obvious from the test output.
 *
 * Why a dedicated module instead of using `encode` / `decode` directly?
 * Keeps the import surface stable, provides a single chokepoint for
 * logging / debugging, and lets PR 5+ swap in a benchmarking wrapper
 * without touching every call site.
 */

import type { ClientFrame, ServerFrame } from "./types.js";

export interface CodecOk<T> {
  ok: true;
  value: T;
}

export interface CodecError {
  ok: false;
  error: string;
}

export type CodecResult<T> = CodecOk<T> | CodecError;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string";
}

function hasNumber(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "number" && Number.isFinite(value[key]);
}

function isPerceptionFrame(value: Record<string, unknown>): boolean {
  const snapshot = value.snapshot;
  return isRecord(snapshot) && isRecord(snapshot.self);
}

function isServerFrame(value: Record<string, unknown>): value is ServerFrame {
  switch (value.kind) {
    case "authOk":
      return hasString(value, "server") && hasNumber(value, "version");
    case "error":
      return hasString(value, "code") && hasString(value, "message");
    case "spawnOk":
      return (
        hasNumber(value, "playerId") &&
        hasNumber(value, "x") &&
        hasNumber(value, "z") &&
        hasNumber(value, "level")
      );
    case "ack":
      return hasString(value, "correlationId") && typeof value.success === "boolean";
    case "perception":
      return isPerceptionFrame(value);
    case "operatorCommand":
      return (
        (value.source === "chat" || value.source === "admin") &&
        hasString(value, "text") &&
        hasNumber(value, "timestamp")
      );
    default:
      return false;
  }
}

/** Encode a client → server frame as a JSON string. Never throws. */
export function encodeClientFrame(frame: ClientFrame): string {
  return JSON.stringify(frame);
}

/** Decode a JSON string received from the server into a typed frame. */
export function decodeServerFrame(raw: string): CodecResult<ServerFrame> {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "empty frame" };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `json decode failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!isRecord(value)) {
    return { ok: false, error: "frame root is not an object" };
  }
  if (typeof value.kind !== "string") {
    return { ok: false, error: "missing or non-string `kind` field" };
  }
  if (!isServerFrame(value)) {
    return { ok: false, error: `invalid server frame: ${value.kind}` };
  }
  return { ok: true, value };
}
