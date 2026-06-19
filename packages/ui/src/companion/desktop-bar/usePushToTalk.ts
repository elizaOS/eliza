import { useCallback, useEffect, useRef, useState } from "react";

export interface PushToTalkHandlers {
  onPushToTalkDown?(): void;
  onPushToTalkUp?(): void;
}

export interface PushToTalkOptions {
  target?: HTMLElement | null;
  enabled?: boolean;
}

export interface PushToTalkState {
  isHolding: boolean;
  trigger: {
    down(): void;
    up(): void;
  };
}

const FN_KEY_CODE = 255;

function isFnKeyEvent(event: KeyboardEvent): boolean {
  return event.code === "Function" || event.keyCode === FN_KEY_CODE;
}

function isSpaceEvent(event: KeyboardEvent): boolean {
  return event.code === "Space";
}

function isModified(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;
}

export function usePushToTalk(
  handlers: PushToTalkHandlers = {},
  options: PushToTalkOptions = {},
): PushToTalkState {
  const { target = null, enabled = true } = options;
  const [isHolding, setIsHolding] = useState(false);
  const holdingRef = useRef(false);

  const down = useCallback((): void => {
    if (holdingRef.current) {
      return;
    }
    holdingRef.current = true;
    setIsHolding(true);
    handlers.onPushToTalkDown?.();
  }, [handlers]);

  const up = useCallback((): void => {
    if (!holdingRef.current) {
      return;
    }
    holdingRef.current = false;
    setIsHolding(false);
    handlers.onPushToTalkUp?.();
  }, [handlers]);

  useEffect(() => {
    if (!enabled || !target) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat) {
        return;
      }
      if (isSpaceEvent(event) && !isModified(event)) {
        const eventTarget = event.target as HTMLElement | null;
        const isTextInput =
          eventTarget instanceof HTMLInputElement ||
          eventTarget instanceof HTMLTextAreaElement;
        if (isTextInput) {
          return;
        }
        event.preventDefault();
        down();
        return;
      }
      if (isFnKeyEvent(event) && !isModified(event)) {
        down();
      }
    };

    const handleKeyUp = (event: KeyboardEvent): void => {
      if (isSpaceEvent(event) || isFnKeyEvent(event)) {
        up();
      }
    };

    target.addEventListener("keydown", handleKeyDown);
    target.addEventListener("keyup", handleKeyUp);
    return () => {
      target.removeEventListener("keydown", handleKeyDown);
      target.removeEventListener("keyup", handleKeyUp);
    };
  }, [enabled, target, down, up]);

  return { isHolding, trigger: { down, up } };
}
