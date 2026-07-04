/**
 * Structured-output recovery helpers. `extractJsonFromText` walks a candidate
 * chain (raw JSON, fenced blocks, first `{...}` span) to salvage an object from
 * a chatty model completion, returning `null` when nothing parses so callers can
 * branch on "unparseable" rather than mistake a fabricated `{}` for a valid empty
 * object. `handleObjectGenerationError` rethrows a generation failure as a typed
 * `ElizaError` (context-adding rethrow) instead of masking it as `{ error }`.
 * `getJsonRepairFunction` optionally loads `jsonrepair` when installed.
 */
import { ElizaError, type JsonValue, logger } from "@elizaos/core";

export function getJsonRepairFunction(): ((text: string) => string) | undefined {
  // error-policy:J3 optional-dependency probe — `jsonrepair` is not a declared
  // dependency; its absence (module-not-found) is the expected "unavailable"
  // signal, distinct from a real failure. Returning undefined is the typed
  // "no repairer" result, not a fabricated success.
  try {
    const { jsonrepair } = require("jsonrepair");
    return jsonrepair;
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      "[openrouter] jsonrepair not installed; skipping JSON repair"
    );
    return undefined;
  }
}

/**
 * Rethrow an object-generation failure as a typed {@link ElizaError}. Never
 * returns — the previous `{ error: message }` shape was indistinguishable from a
 * model that legitimately produced `{ error: ... }`, so a failed generation read
 * as a successful one downstream.
 */
export function handleObjectGenerationError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  throw new ElizaError(`Object generation failed: ${message}`, {
    code: "MODEL_OBJECT_GENERATION_FAILED",
    cause: error,
  });
}

/**
 * Parse a JSON object out of a model completion, trying raw text then fenced and
 * inline `{...}` spans. Returns `null` when no candidate parses — an explicit
 * "unparseable" signal callers must branch on; it never fabricates a valid `{}`.
 */
export function extractJsonFromText(text: string): Record<string, JsonValue> | null {
  const candidates: string[] = [text];

  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch?.[1]) {
    candidates.push(jsonBlockMatch[1].trim());
  }

  const codeBlockMatch = text.match(/```\w*\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch?.[1]) {
    const content = codeBlockMatch[1].trim();
    if (content.startsWith("{") && content.endsWith("}")) {
      candidates.push(content);
    }
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch?.[0]) {
    candidates.push(jsonMatch[0]);
  }

  for (const candidate of candidates) {
    // error-policy:J3 untrusted-input sanitizing — probing each candidate for
    // parseability is expected; a non-parsing candidate falls through to the
    // next, and exhausting all of them yields the typed `null` invalid signal.
    try {
      return JSON.parse(candidate) as Record<string, JsonValue>;
    } catch {}
  }

  return null;
}
