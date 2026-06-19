/**
 * JSON Parsing Utilities
 *
 * Shared utilities for safe JSON parsing with consistent error handling.
 * Consolidates duplicate JSON parsing patterns.
 */

import { extractErrorMessage } from "./error-handling";

/**
 * Safely parse JSON response, returning empty object on failure
 * Use when parsing error responses where JSON might be malformed
 */
export async function safeJsonParse<T = Record<string, unknown>>(response: Response): Promise<T> {
  try {
    const text = await response.text();
    if (!text.trim()) {
      return {} as T;
    }
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
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
