import { useSyncExternalStore } from "react";

let active = false;
const listeners = new Set<() => void>();

function snapshot(): boolean {
  return active;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * True only after the native host has decoded and installed the current image
 * wallpaper. Native glass must never activate before this flips true, because
 * an under-WebView material without a native backdrop reveals the window
 * background instead of the wallpaper.
 */
export function useNativeBackdropActive(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

export function setNativeBackdropActive(next: boolean): void {
  if (active === next) return;
  active = next;
  for (const listener of listeners) listener();
}

export function isNativeBackdropActive(): boolean {
  return active;
}

export function resetNativeBackdropForTests(): void {
  active = false;
  listeners.clear();
}
