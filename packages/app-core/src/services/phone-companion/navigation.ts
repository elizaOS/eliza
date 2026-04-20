import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { Preferences } from "@capacitor/preferences";
import { useCallback, useEffect, useState } from "react";
import { logger } from "./logger";

/**
 * Minimal stack navigator for the phone-companion surface.
 *
 * We intentionally avoid react-router / react-native-navigation: the companion
 * has three screens and a linear push/pop model. This hook handles state,
 * persists the current view across launches, and fires a Capacitor haptic on
 * each transition (a no-op on web).
 */

export type ViewName = "chat" | "pairing" | "remote-session";

const STORAGE_KEY = "milady.companion.nav.v1";
const DEFAULT_VIEW: ViewName = "chat";

export interface NavState {
  view: ViewName;
  ready: boolean;
  push(next: ViewName): void;
  pop(fallback: ViewName): void;
}

export function useNavigation(): NavState {
  const [view, setView] = useState<ViewName>(DEFAULT_VIEW);
  const [stack, setStack] = useState<ViewName[]>([DEFAULT_VIEW]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    Preferences.get({ key: STORAGE_KEY }).then((result) => {
      if (result.value !== null) {
        const parsed = parseStack(result.value);
        if (parsed.length > 0) {
          setStack(parsed);
          setView(parsed[parsed.length - 1]);
        }
      }
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!ready) return;
    const serialized = JSON.stringify(stack);
    Preferences.set({ key: STORAGE_KEY, value: serialized });
  }, [stack, ready]);

  const push = useCallback((next: ViewName) => {
    logger.info("[navigation] push", { next });
    triggerHaptic();
    setStack((current) =>
      current[current.length - 1] === next ? current : [...current, next],
    );
    setView(next);
  }, []);

  const pop = useCallback((fallback: ViewName) => {
    logger.info("[navigation] pop", { fallback });
    triggerHaptic();
    setStack((current) => {
      if (current.length <= 1) return [fallback];
      const next = current.slice(0, -1);
      setView(next[next.length - 1]);
      return next;
    });
  }, []);

  return { view, ready, push, pop };
}

function parseStack(raw: string): ViewName[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isViewName);
}

function isViewName(value: unknown): value is ViewName {
  return value === "chat" || value === "pairing" || value === "remote-session";
}

function triggerHaptic(): void {
  if (!Capacitor.isNativePlatform()) return;
  Haptics.impact({ style: ImpactStyle.Light }).catch((err: unknown) => {
    logger.debug("[navigation] haptic unavailable", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
