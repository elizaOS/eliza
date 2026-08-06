"use client";

import { useState, useEffect } from "react";

export interface ViewportHeightState {
  viewportHeight: number;
  keyboardHeight: number;
  isKeyboardOpen: boolean;
}

/**
 * Tracks the visual viewport height to handle mobile keyboard open/close.
 * Uses the VisualViewport API so we don't rely on position:fixed (which breaks on iOS).
 */
export function useViewportHeight(): ViewportHeightState {
  const [state, setState] = useState<ViewportHeightState>({
    viewportHeight: typeof window !== "undefined" ? window.innerHeight : 0,
    keyboardHeight: 0,
    isKeyboardOpen: false,
  });

  useEffect(() => {
    const vv = window.visualViewport;

    const update = () => {
      const fullHeight = window.innerHeight;
      const visibleHeight = vv ? vv.height : fullHeight;
      const keyboardHeight = Math.max(0, fullHeight - visibleHeight);
      setState({
        viewportHeight: visibleHeight,
        keyboardHeight,
        isKeyboardOpen: keyboardHeight > 50,
      });
    };

    update();

    if (vv) {
      vv.addEventListener("resize", update);
      vv.addEventListener("scroll", update);
      return () => {
        vv.removeEventListener("resize", update);
        vv.removeEventListener("scroll", update);
      };
    } else {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
  }, []);

  return state;
}
