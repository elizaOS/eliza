/**
 * Formats unknown diagnostic values without invoking an untrusted getter,
 * proxy trap, or coercion path that can mask the original runtime failure.
 */

function isPropertyContainer(
  value: unknown,
): value is Record<PropertyKey, unknown> | ((...args: never[]) => unknown) {
  return (
    value !== null && (typeof value === "object" || typeof value === "function")
  );
}

export function readDiagnosticProperty(
  value: unknown,
  property: PropertyKey,
): unknown {
  if (!isPropertyContainer(value)) return undefined;
  try {
    return Reflect.get(value, property);
  } catch {
    // error-policy:J7 diagnostic inspection must not mask the original failure
    return undefined;
  }
}

function readNonBlankString(
  value: unknown,
  property: PropertyKey,
): string | null {
  const candidate = readDiagnosticProperty(value, property);
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    // error-policy:J7 diagnostic coercion must not mask the original failure
    try {
      return Object.prototype.toString.call(value);
    } catch {
      // error-policy:J7 hostile type-tag access still needs printable output
      return "[unstringifiable error]";
    }
  }
}

export function formatDiagnosticError(value: unknown): string {
  return (
    readNonBlankString(value, "stack") ??
    readNonBlankString(value, "message") ??
    safeString(value)
  );
}
