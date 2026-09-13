/**
 * Canonical SQL type normalization for the runtime migrator.
 *
 * WHY this is one module: `diff-calculator` decides whether a column's type
 * CHANGED, and `sql-generator` decides whether that change is DESTRUCTIVE.
 * Both answers come from normalizing the two type strings, so if the two sides
 * normalize differently the migrator contradicts itself -- the diff reports a
 * change the generator then treats as a no-op, and the same ALTER is re-emitted
 * on every run. They previously kept private copies of this function and had
 * already drifted: `diff-calculator`'s copy was missing the `timestamptz`
 * alias, so `timestamp with time zone` vs `timestamptz` compared as different
 * there and identical here.
 */

/**
 * Normalize SQL types for comparison
 * Handles equivalent type variations between introspected DB and schema definitions
 */
export function normalizeType(type: string | undefined): string {
  if (!type) return "";

  const normalized = type.toLowerCase().trim();

  // Handle timestamp variations - all are equivalent
  if (
    normalized === "timestamp without time zone" ||
    normalized === "timestamp with time zone" ||
    normalized === "timestamptz"
  ) {
    return "timestamp";
  }

  // Handle serial vs integer with identity
  // serial is essentially integer with auto-increment
  if (normalized === "serial") {
    return "integer";
  }
  if (normalized === "bigserial") {
    return "bigint";
  }
  if (normalized === "smallserial") {
    return "smallint";
  }

  // Handle numeric/decimal equivalence
  if (normalized.startsWith("numeric") || normalized.startsWith("decimal")) {
    // Extract precision and scale if present
    const match = normalized.match(/\((\d+)(?:,\s*(\d+))?\)/);
    if (match) {
      return `numeric(${match[1]}${match[2] ? `,${match[2]}` : ""})`;
    }
    return "numeric";
  }

  // Handle varchar/character varying
  if (normalized.startsWith("character varying")) {
    return normalized.replace("character varying", "varchar");
  }

  // Handle text array variations
  if (normalized === "text[]" || normalized === "_text") {
    return "text[]";
  }

  return normalized;
}
