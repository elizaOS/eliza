/**
 * Wires the keyboard chord that opens the Secrets Manager modal onto its
 * single open action.
 */
import { useEffect } from "react";
import { dispatchSecretsManagerOpen } from "./useSecretsManagerModal";

/**
 * Wires the keyboard trigger for the Secrets Manager modal: a `keydown`
 * listener on `document` catches the chord in every Eliza window.
 *   Mac default: ⌘⌥⌃V (Command + Option + Control + V)
 *   Win/Linux:   Ctrl + Alt + Shift + V
 *
 * Mount this hook ONCE in the top-level App component alongside the
 * lazy `SecretsManagerModalMount` (App.tsx).
 */
export function useSecretsManagerShortcut(): void {
  // Renderer-side keydown
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (!matchesShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dispatchSecretsManagerOpen();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, []);
}

/**
 * Detects the Secrets-Manager shortcut. Per-platform mapping:
 *   - macOS (`navigator.platform.includes("Mac")`):
 *       metaKey (⌘) + altKey (⌥) + ctrlKey (⌃) + key === "v"
 *   - Otherwise:
 *       ctrlKey + altKey + shiftKey + key === "v"
 */
export function matchesShortcut(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== "v" && event.code !== "KeyV") return false;
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  if (isMac) {
    return event.metaKey && event.altKey && event.ctrlKey && !event.shiftKey;
  }
  return event.ctrlKey && event.altKey && event.shiftKey && !event.metaKey;
}

/** Human-readable label for the shortcut, suitable for UI hints. */
export function getShortcutLabel(): string {
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  return isMac ? "⌘⌥⌃V" : "Ctrl+Alt+Shift+V";
}
