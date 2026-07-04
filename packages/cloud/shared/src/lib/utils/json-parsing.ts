/**
 * Response JSON helpers for cloud service clients.
 *
 * Success responses parse strictly so malformed provider payloads surface as
 * integration failures. Error responses have a separate best-effort parser
 * because third-party APIs often return empty or non-JSON bodies alongside a
 * useful HTTP status.
 */

import { extractErrorMessage } from "./error-handling";

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
