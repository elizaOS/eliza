import { getInferenceTimer, timeInferenceSpan } from "@elizaos/core";

/** Existing-turn diagnostics only. A returned call is not an applied effect. */
export function timeCalendarUpdate<T>(
  operation: "source-read" | "extract" | "availability" | "persist",
  run: () => Promise<T>,
): Promise<T> {
  if (!getInferenceTimer()) return run();
  const meta = { returned: false };
  return timeInferenceSpan(
    `actions:calendar:update:${operation}`,
    async () => {
      const result = await run();
      meta.returned = true;
      return result;
    },
    meta,
  );
}
