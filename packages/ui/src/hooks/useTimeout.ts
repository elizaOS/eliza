import { useCallback, useEffect, useRef } from "react";

export function useTimeout() {
  const timeoutRefs = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const setSafeTimeout = useCallback((callback: () => void, ms: number) => {
    const id = setTimeout(() => {
      timeoutRefs.current.delete(id);
      callback();
    }, ms);
    timeoutRefs.current.add(id);
    return id;
  }, []);

  const clearSafeTimeout = useCallback((id: ReturnType<typeof setTimeout>) => {
    clearTimeout(id);
    timeoutRefs.current.delete(id);
  }, []);

  useEffect(() => {
    const refs = timeoutRefs;
    return () => {
      for (const id of refs.current) {
        clearTimeout(id);
      }
      refs.current.clear();
    };
  }, []);

  return { setTimeout: setSafeTimeout, clearTimeout: clearSafeTimeout };
}
