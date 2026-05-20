export function getRuntimeStateCache(runtime: unknown):
  | Map<
      string,
      {
        values?: Record<string, unknown>;
        data?: Record<string, unknown>;
        text?: string;
      }
    >
  | undefined {
  return (
    runtime as {
      stateCache?: Map<
        string,
        {
          values?: Record<string, unknown>;
          data?: Record<string, unknown>;
          text?: string;
        }
      >;
    }
  ).stateCache;
}

export function cleanupRuntimeStateCache(
  runtime: unknown,
  messageId?: string
): void {
  if (!messageId) return;
  const stateCache = getRuntimeStateCache(runtime);
  stateCache?.delete(messageId);
  stateCache?.delete(`${messageId}_action_results`);
}
