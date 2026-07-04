/** Normalizes an unknown thrown value into a display string for connector hooks, falling back to a caller-supplied message when no error text is available. */
export function formatConnectorError(cause: unknown, fallback: string): string {
  if (cause instanceof Error) {
    const message = cause.message.trim();
    if (message.length > 0) {
      return message;
    }
  }
  return fallback;
}
