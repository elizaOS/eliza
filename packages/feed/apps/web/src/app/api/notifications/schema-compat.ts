const MISSING_NOTIFICATION_SCHEMA_ERROR_CODES = new Set(['42P01', '42703']);

export function getMissingNotificationSchemaErrorCode(
  error: unknown
): string | null {
  const causeCode = (error as { cause?: { code?: string } } | null)?.cause
    ?.code;
  const code = causeCode ?? (error as { code?: string } | null)?.code ?? null;

  return code && MISSING_NOTIFICATION_SCHEMA_ERROR_CODES.has(code)
    ? code
    : null;
}

export function isMissingNotificationSchemaError(error: unknown): boolean {
  return getMissingNotificationSchemaErrorCode(error) !== null;
}
