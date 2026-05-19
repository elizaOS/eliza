import { useEffect } from "react";
import { subscribeDesktopBridgeEvent } from "../bridge/electrobun-rpc";
import { dispatchSecretsManagerOpen } from "./useSecretsManagerModal";

/**
 * Wires the keyboard / menu triggers for the Secrets Manager modal.
 *
 * Two trigger paths feed the same open action:
 *
 *   1. **Renderer-side keyboard chord** — caught by a `keydown`
 *      listener on `document`. Handles every Eliza window.
 *      Mac default: ⌘⌥⌃V (Command + Option + Control + V)
 *      Win/Linux:   Ctrl + Alt + Shift + V
 *
 *   2. **Application menu accelerator** — Electrobun's bun-side menu
 *      registers an item with the same accelerator. When the user
 *      hits the chord, bun fires `application-menu-clicked` with
 *      action `"open-secrets-manager"`, the bun handler turns that
 *      into `sendToActiveRenderer("openSecretsManager", {})`, and
 *      this hook subscribes to receive it. Both routes converge on
 *      the same toggle dispatch.
 *
 * Mount this hook ONCE in the top-level App component alongside the
 * `<SecretsManagerModalRoot />` mount.
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

  // Bun-side menu accelerator route
  useEffect(() => {
    return subscribeDesktopBridgeEvent({
      rpcMessage: "openSecretsManager",
      ipcChannel: "desktop:openSecretsManager",
      listener: () => {
        dispatchSecretsManagerOpen();
      },
    });
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

/** Electron-style accelerator string for the menu item. */
export const SECRETS_MANAGER_MAC_ACCELERATOR = "Command+Option+Control+V";
export const SECRETS_MANAGER_OTHER_ACCELERATOR = "Ctrl+Alt+Shift+V";
