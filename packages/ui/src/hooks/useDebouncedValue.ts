/**
 * useDebouncedValue — returns `value` only after it has stayed unchanged
 * for `delayMs`. Used by `WorkflowEditor` so the React Flow viewer
 * doesn't re-parse JSON on every keystroke.
 */

import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
