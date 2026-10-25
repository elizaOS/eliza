/** Read a human message off an unknown error, falling back to `fallback`. */
export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
