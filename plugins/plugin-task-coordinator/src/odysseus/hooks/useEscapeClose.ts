// Shared modal affordance for the odysseus port: while `open`, a global Escape
// keypress invokes `onClose`. Every view-modal (panels + full-bleed tool views)
// uses this so close-on-Escape is consistent with odysseus's modal behaviour
// regardless of where focus sits.

import { useEffect } from "react";

export function useEscapeClose(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
}
