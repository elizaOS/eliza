import { useEffect, useRef, useState } from "react";

export function useDocumentVisibility(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === "undefined"
      ? true
      : document.visibilityState === "visible",
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    const sync = () => setVisible(document.visibilityState === "visible");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  return visible;
}

export function useIntervalWhenDocumentVisible(
  callback: () => void,
  delayMs: number,
  enabled = true,
): void {
  const saved = useRef(callback);
  saved.current = callback;
  const visible = useDocumentVisibility();

  useEffect(() => {
    if (!enabled || !visible) return;
    const id = window.setInterval(() => {
      saved.current();
    }, delayMs);
    return () => window.clearInterval(id);
  }, [enabled, visible, delayMs]);
}
