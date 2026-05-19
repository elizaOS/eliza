import { useCallback, useEffect, useState } from "react";

import type { MicState } from "./types";

export interface KeyboardShortcutHandlers {
  onToggleExpand?(next: boolean): void;
  onPushToTalkDown?(): void;
  onPushToTalkUp?(): void;
  onMicStateChange?(next: MicState): void;
}

export interface KeyboardShortcutOptions {
  enabled?: boolean;
  composerElement?: HTMLElement | null;
}

export interface KeyboardShortcutsState {
  isOpen: boolean;
  micState: MicState;
  setOpen(next: boolean): void;
  setMicState(next: MicState): void;
}

const FN_KEY_CODE = 255;

function hasOtherModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;
}

export function useKeyboardShortcuts(
  handlers: KeyboardShortcutHandlers = {},
  options: KeyboardShortcutOptions = {},
): KeyboardShortcutsState {
  const { enabled = true, composerElement = null } = options;
  const [isOpen, setIsOpenState] = useState(false);
  const [micState, setMicStateInternal] = useState<MicState>("off");

  const setOpen = useCallback(
    (next: boolean) => {
      setIsOpenState((prev) => {
        if (prev === next) {
          return prev;
        }
        handlers.onToggleExpand?.(next);
        return next;
      });
    },
    [handlers],
  );

  const setMicState = useCallback(
    (next: MicState) => {
      setMicStateInternal((prev) => {
        if (prev === next) {
          return prev;
        }
        handlers.onMicStateChange?.(next);
        return next;
      });
    },
    [handlers],
  );

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    const handleGlobalKeyDown = (event: KeyboardEvent): void => {
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.code === "Space"
      ) {
        event.preventDefault();
        setIsOpenState((prev) => {
          const next = !prev;
          handlers.onToggleExpand?.(next);
          return next;
        });
        return;
      }

      const isFnKey =
        event.code === "Function" || event.keyCode === FN_KEY_CODE;
      if (isFnKey && !hasOtherModifier(event) && !event.repeat) {
        handlers.onPushToTalkDown?.();
      }
    };

    const handleGlobalKeyUp = (event: KeyboardEvent): void => {
      const isFnKey =
        event.code === "Function" || event.keyCode === FN_KEY_CODE;
      if (isFnKey) {
        handlers.onPushToTalkUp?.();
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    window.addEventListener("keyup", handleGlobalKeyUp);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
      window.removeEventListener("keyup", handleGlobalKeyUp);
    };
  }, [enabled, handlers]);

  useEffect(() => {
    if (!enabled || !composerElement) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== "Space" || hasOtherModifier(event) || event.repeat) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const isTextInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement;
      if (isTextInput) {
        return;
      }
      event.preventDefault();
      handlers.onPushToTalkDown?.();
    };

    const handleKeyUp = (event: KeyboardEvent): void => {
      if (event.code !== "Space") {
        return;
      }
      const target = event.target as HTMLElement | null;
      const isTextInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement;
      if (isTextInput) {
        return;
      }
      handlers.onPushToTalkUp?.();
    };

    composerElement.addEventListener("keydown", handleKeyDown);
    composerElement.addEventListener("keyup", handleKeyUp);
    return () => {
      composerElement.removeEventListener("keydown", handleKeyDown);
      composerElement.removeEventListener("keyup", handleKeyUp);
    };
  }, [enabled, composerElement, handlers]);

  return { isOpen, micState, setOpen, setMicState };
}
