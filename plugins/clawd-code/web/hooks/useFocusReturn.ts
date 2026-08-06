"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Saves the currently focused element and returns a function to restore focus to it.
 * Use when opening modals/dialogs to return focus to the trigger on close.
 *
 * @example
 * const returnFocus = useFocusReturn();
 *
 * const openDialog = () => {
 *   returnFocus.save(); // call before showing the dialog
 *   setOpen(true);
 * };
 *
 * const closeDialog = () => {
 *   setOpen(false);
 *   returnFocus.restore(); // call after hiding the dialog
 * };
 */
export function useFocusReturn() {
  const savedRef = useRef<HTMLElement | null>(null);

  const save = useCallback(() => {
    savedRef.current = document.activeElement as HTMLElement | null;
  }, []);

  const restore = useCallback(() => {
    if (savedRef.current && typeof savedRef.current.focus === "function") {
      savedRef.current.focus();
      savedRef.current = null;
    }
  }, []);

  // Safety cleanup on unmount
  useEffect(() => () => { savedRef.current = null; }, []);

  return { save, restore };
}
