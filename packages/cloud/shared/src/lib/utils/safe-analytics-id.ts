/**
 * Validates client-supplied analytics identifiers (visitor/session ids) at the
 * runtime boundary. Beacon and cookie ids are UUIDs or short random tokens;
 * anything else (wrong type, empty, oversized, unsafe charset) is rejected so
 * it never reaches persisted metadata or injected HTML.
 */
export function safeAnalyticsId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{8,128}$/.test(value) ? value : null;
}
