/**
 * JSON helpers for Cloud request boundaries and service-client responses.
 *
 * Success responses parse strictly so malformed provider payloads surface as
 * integration failures. Error responses have a separate best-effort parser
 * because third-party APIs often return empty or non-JSON bodies alongside a
 * useful HTTP status.
 */

import { extractErrorMessage } from "./error-handling";

export type RequestJsonDecodeResult = { ok: true; value: unknown } | { ok: false };

/**
 * Decode an untrusted request body without disguising transport/runtime faults
 * as malformed caller input. Body acquisition completes before the narrow
 * `JSON.parse` boundary, so stream, abort, and decoder failures propagate to
 * the route's normal 5xx handler. Syntax details are discarded because engine
 * diagnostics can quote sensitive request content.
 */
export async function decodeRequestJson(source: {
  text(): Promise<string>;
}): Promise<RequestJsonDecodeResult> {
  const text = await source.text();
  if (typeof text !== "string") {
    throw new TypeError("Request body decoder returned a non-string value");
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // error-policy:J3 malformed JSON is explicit invalid request input.
    return { ok: false };
  }
}

/**
 * Parse a response body as JSON, preserving empty or malformed payloads as
 * failures for the caller to handle at the service boundary.
 */
export async function parseJsonResponse<T = Record<string, unknown>>(
  response: Response,
  context?: string,
): Promise<T> {
  const text = await response.text();
  if (!text.trim()) {
    const contextMsg = context ? ` (${context})` : "";
    throw new Error(`Failed to parse JSON${contextMsg}: empty response body`);
  }
  return parseJson<T>(text, context);
}

/**
 * Best-effort parser for provider error bodies where the HTTP status remains
 * the failure signal when the body is empty or malformed.
 */
export async function parseJsonErrorBody<T extends object>(
  response: Response,
): Promise<Partial<T>> {
  // error-policy:J3 Third-party error bodies are untrusted diagnostics; invalid
  // JSON becomes an explicit "no parsed details" result while the caller still
  // throws based on the non-OK HTTP status.
  const text = await response.text().catch(() => "");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as Partial<T>;
  } catch {
    return {};
  }
}

/**
 * Parse JSON with proper error handling
 * Throws descriptive error if parsing fails
 */
export function parseJson<T>(text: string, context?: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const contextMsg = context ? ` (${context})` : "";
    throw new Error(`Failed to parse JSON${contextMsg}: ${extractErrorMessage(error)}`);
  }
}
