import { useCallback, useEffect, useState } from "react";

type Size = {
  width: number;
  height: number;
};

export function useElementSize<T extends HTMLElement>(): [
  (node: T | null) => void,
  Size,
] {
  const [element, setElement] = useState<T | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  const ref = useCallback((node: T | null) => {
    setElement(node);
  }, []);

  useEffect(() => {
    if (!element) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const box = entry.contentRect;
      setSize({ width: box.width, height: box.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return [ref, size];
}
