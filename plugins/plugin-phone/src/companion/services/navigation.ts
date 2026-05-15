import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { Preferences } from "@capacitor/preferences";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const STORAGE_KEY = "eliza.companion.nav.v1";
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
  const stackRef = useRef(stack);
  stackRef.current = stack;

  useEffect(() => {
    void (async () => {
      try {
        const result = await Preferences.get({ key: STORAGE_KEY });
        if (result.value !== null) {
          const parsed = parseStack(result.value);
          if (parsed.length > 0) {
            setStack(parsed);
            setView(parsed[parsed.length - 1]);
          }
        }
      } catch (err) {
        logger.warn(
          "[navigation] failed to restore navigation from preferences",
          {
            error: err instanceof Error ? err.message : String(err),
          },
        );
        setStack([DEFAULT_VIEW]);
        setView(DEFAULT_VIEW);
      } finally {
        setReady(true);
      }
    })();
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
    const current = stackRef.current;
    let nextStack: ViewName[];
    let nextView: ViewName;
    if (current.length <= 1) {
      nextStack = [fallback];
      nextView = fallback;
    } else {
      nextStack = current.slice(0, -1);
      nextView = nextStack[nextStack.length - 1];
    }
    stackRef.current = nextStack;
    setStack(nextStack);
    setView(nextView);
  }, []);

  return useMemo(() => ({ view, ready, push, pop }), [view, ready, push, pop]);
}

let hasLoggedInvalidStoredStack = false;

function parseStack(raw: string): ViewName[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isViewName);
  } catch (err: unknown) {
    if (!hasLoggedInvalidStoredStack) {
      hasLoggedInvalidStoredStack = true;
      logger.info(
        "[navigation] invalid persisted stack; falling back to default view",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
    return [];
  }
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
