/** Reads nullable serialized record objects from LifeOps SQL rows. */
import { parseJsonRecord } from "../sql.js";

// ScheduledTask row parsers (private helpers).

export function parseOptionalJsonRecord<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.length === 0) return undefined;
  const parsed = parseJsonRecord(value);
  if (Object.keys(parsed).length === 0) return undefined;
  return parsed as T;
}
