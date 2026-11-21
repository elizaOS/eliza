/**
 * Structural conformance of a parsed extraction record to the object
 * `responseSchema` the calendar sent with the model call.
 *
 * Providers do not all enforce structured output strictly: a schema-bound
 * update extraction has come back as `{}` (two completion tokens), which the
 * handler then read as "the user requested no change". This check judges the
 * record only against the declared schema, never against the user's words:
 *
 * - the record must carry at least one property the schema declares; an
 *   empty record, or one made only of undeclared keys, extracted nothing;
 * - every present declared property that names a JSON `type` must have it.
 *
 * Omitted declared properties are not violations by themselves: calendar
 * consumers read an omitted nullable field as `null`, an omitted boolean as
 * false and an omitted list as empty, exactly as before this check.
 *
 * It never fills or invents a value.
 */
import type { CalendarModelCallArgs } from "./deps.js";

type ExtractionSchema = NonNullable<CalendarModelCallArgs["responseSchema"]>;

function declaredTypes(schema: ExtractionSchema): string[] | null {
  const { type } = schema as { type?: string | string[] };
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type;
  return null;
}

function jsonTypeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        value !== null && typeof value === "object" && !Array.isArray(value)
      );
    default:
      // An unknown declared type is not evidence against the record.
      return true;
  }
}

/**
 * Returns the schema violations of `parsed`, or an empty list when it
 * conforms. A `null` record (unparseable output) is one violation.
 */
export function calendarExtractionSchemaViolations(
  schema: ExtractionSchema,
  parsed: Record<string, unknown> | null | undefined,
): string[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return ["the response is not a JSON object"];
  }
  const properties =
    (schema as { properties?: Record<string, ExtractionSchema> }).properties ??
    {};
  const violations: string[] = [];
  // `undefined` is not a JSON value: a key holding it was omitted.
  const present = Object.entries(parsed).filter(
    ([, value]) => value !== undefined,
  );
  const declared = present.filter(([key]) => Object.hasOwn(properties, key));
  if (declared.length === 0) {
    const required = (schema as { required?: string[] }).required ?? [];
    violations.push(
      required.length > 0
        ? `none of the schema fields were returned (required: ${required.join(", ")})`
        : "none of the schema fields were returned",
    );
  }
  for (const [key, value] of present) {
    const propertySchema = properties[key];
    if (!propertySchema) continue;
    const types = declaredTypes(propertySchema);
    if (types && !types.some((type) => jsonTypeMatches(value, type))) {
      violations.push(`field "${key}" must be ${types.join(" or ")}`);
    }
  }
  return violations;
}
