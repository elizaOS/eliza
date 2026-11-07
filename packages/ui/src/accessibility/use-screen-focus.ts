import { useEffect, useRef } from "react";
import {
  createScreenFocus,
  type ScreenFocus,
  type ScreenFocusOptions,
} from "./screen-focus";

/**
 * Focus follows the screen for a React shell (createScreenFocus): whenever
 * `screen` changes, dropped focus moves to the name of the screen now in front
 * once it has rendered. The first value is the screen a load starts on, not a
 * change. The latest options are used for each judgement; the document, root
 * and focus ring are read once, when the shell mounts.
 */
export function useScreenFocus(
  screen: string | null,
  options: ScreenFocusOptions,
): void {
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const controller = useRef<ScreenFocus | null>(null);
  useEffect(() => {
    const initial = latest.current;
    const focus = createScreenFocus({
      ...initial,
      screen: (doc) => latest.current.screen(doc),
      ready: () => latest.current.ready?.() ?? true,
    });
    controller.current = focus;
    return () => {
      focus.dispose();
      if (controller.current === focus) controller.current = null;
    };
  }, []);
  const shown = useRef(screen);
  useEffect(() => {
    if (shown.current === screen) return;
    shown.current = screen;
    controller.current?.screenChanged();
  }, [screen]);
}
