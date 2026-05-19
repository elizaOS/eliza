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
export declare function useSecretsManagerShortcut(): void;
/**
 * Detects the Secrets-Manager shortcut. Per-platform mapping:
 *   - macOS (`navigator.platform.includes("Mac")`):
 *       metaKey (⌘) + altKey (⌥) + ctrlKey (⌃) + key === "v"
 *   - Otherwise:
 *       ctrlKey + altKey + shiftKey + key === "v"
 */
export declare function matchesShortcut(event: KeyboardEvent): boolean;
/** Human-readable label for the shortcut, suitable for UI hints. */
export declare function getShortcutLabel(): string;
/** Electron-style accelerator string for the menu item. */
export declare const SECRETS_MANAGER_MAC_ACCELERATOR = "Command+Option+Control+V";
export declare const SECRETS_MANAGER_OTHER_ACCELERATOR = "Ctrl+Alt+Shift+V";
//# sourceMappingURL=useSecretsManagerShortcut.d.ts.map