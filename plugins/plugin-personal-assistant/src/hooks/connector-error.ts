export function formatConnectorError(cause: unknown, fallback: string): string {
  if (cause instanceof Error) {
    const message = cause.message.trim();
    if (message.length > 0) {
      return message;
    }
  }
  return fallback;
}
