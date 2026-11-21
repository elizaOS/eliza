/**
 * Structural conformance of a parsed extraction record to the object
 * `responseSchema` the calendar sent with the model call.
 *
 * Providers do not all enforce structured output strictly: a schema-bound
 * update extraction has come back as `{}` (two completion tokens), which the
 * handler then read as "the user requested no change". This check judges the
 * record only against the declared schema, never against the user's words, and
 * rejects exactly two shapes:
 *
 * - a result that is not a JSON object (unparseable output, an array, ...);
 * - an object that carries none of the schema's declared properties: `{}`, a
 *   record made only of undeclared keys, or one whose declared properties are
 *   all `null`.
 *
 * `null` counts as omitted. The extraction prompts ask the model to use null
 * for unchanged or unknown values, and every calendar consumer already reads a
 * null field exactly as an omitted one (`Array.isArray` guards, `=== true`
 * checks, `detailString`, string-tolerant flag normalizers). For the same
 * reason the value types of present fields are not checked here: coercing or
 * ignoring a loosely typed value stays with the consumer that reads it, as it
 * did before this check.
 *
 * It never fills or invents a value.
 */
import type { CalendarModelCallArgs } from "./deps.js";

type ExtractionSchema = NonNullable<CalendarModelCallArgs["responseSchema"]>;

/**
 * Returns the schema violations of `parsed`, or an empty list when it
 * conforms. A `null` record (unparseable output) is one violation.
 */
export function calendarExtractionSchemaViolations(
  schema: ExtractionSchema,
  parsed: unknown,
): string[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return ["the response is not a JSON object"];
  }
  const properties =
    (schema as { properties?: Record<string, ExtractionSchema> }).properties ??
    {};
  const carriesDeclaredValue = Object.entries(parsed).some(
    ([key, value]) =>
      Object.hasOwn(properties, key) && value !== null && value !== undefined,
  );
  if (carriesDeclaredValue) return [];
  const required = (schema as { required?: string[] }).required ?? [];
  return [
    required.length > 0
      ? `none of the schema fields were returned (required: ${required.join(", ")})`
      : "none of the schema fields were returned",
  ];
}
