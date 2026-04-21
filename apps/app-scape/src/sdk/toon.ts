/**
 * Thin TOON adapter for the 'scape bot-SDK client.
 *
 * Wraps `@toon-format/toon` with helpers that mirror the xRSPS server's
 * `BotSdkCodec` — same structure, same error surface, so regressions on
 * either side are obvious from the test output.
 *
 * Why a dedicated module instead of using `encode` / `decode` directly?
 * Keeps the import surface stable, provides a single chokepoint for
 * logging / debugging, and lets PR 5+ swap in a benchmarking wrapper
 * without touching every call site.
 */

import { decode, encode } from "@toon-format/toon";

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

/** Encode a client → server frame as a TOON string. Never throws. */
export function encodeClientFrame(frame: ClientFrame): string {
  return encode(frame as unknown as Record<string, unknown>);
}

/** Decode a TOON string received from the server into a typed frame. */
export function decodeServerFrame(raw: string): CodecResult<ServerFrame> {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "empty frame" };
  }
  let value: unknown;
  try {
    value = decode(raw);
  } catch (err) {
    return {
      ok: false,
      error: `toon decode failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "frame root is not an object" };
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.kind !== "string") {
    return { ok: false, error: "missing or non-string `kind` field" };
  }
  return { ok: true, value: obj as unknown as ServerFrame };
}
