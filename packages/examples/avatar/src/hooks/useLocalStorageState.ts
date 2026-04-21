import { useCallback, useEffect, useState } from "react";

export function useLocalStorageState<T>(key: string, initialValue: T): [T, (patch: (prev: T) => T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return initialValue;
      return JSON.parse(raw) as T;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore storage errors (private mode, quota, etc.)
    }
  }, [key, value]);

  const update = useCallback((patch: (prev: T) => T) => {
    setValue((prev) => patch(prev));
  }, []);

  return [value, update];
}

