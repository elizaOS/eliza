/**
 * User-configurable global hotkey that toggles the floating chat surface
 * (#10716 / #12184). On desktop the main window *is* the chat-overlay bottom
 * bar, so the hotkey toggles it: when the window is already focused + visible
 * the press dismisses it (focus returns to the previously active app);
 * otherwise it shows + focuses it. The chosen accelerator is registered with
 * the OS via `Desktop.registerShortcut({ id: "chat-overlay" })`; pressing it
 * fires `desktopShortcutPressed`, which the shell handles with the pure
 * `decideChatOverlayToggle()` decision (packages/app/src/desktop-hotkey.ts).
 *
 * This is intentionally separate from the `command-palette` binding
 * (`CommandOrControl+K`): summoning chat and opening the palette are distinct
 * actions, so both shortcuts are registered and the default chat accelerator is
 * chosen to not collide with the palette (nor with Option+Space, which Claude
 * and ChatGPT desktop both squat). Built on the keyed desktop-hotkey store
 * (./desktop-hotkeys — persistence, cross-tab sync, accelerator parsing) with
 * the historical `eliza:chatOverlayHotkey` storage key so persisted settings
 * survive; the voice/transcribe hotkeys are sibling instances of the same
 * store.
 */
import { useSyncExternalStore } from "react";
import {
  createDesktopHotkeyStore,
  type DesktopHotkey,
} from "./desktop-hotkeys";

export {
  acceleratorFromKeyboardEvent,
  normalizeAccelerator,
} from "./desktop-hotkeys";

export type ChatOverlayHotkey = DesktopHotkey;

/**
 * Default summon accelerator. Distinct from `CommandOrControl+K`
 * (command-palette) so registering both never conflicts.
 */
export const DEFAULT_CHAT_OVERLAY_ACCELERATOR = "CommandOrControl+Shift+C";

export const chatOverlayHotkeyStore = createDesktopHotkeyStore({
  storageKey: "eliza:chatOverlayHotkey",
  defaultAccelerator: DEFAULT_CHAT_OVERLAY_ACCELERATOR,
  defaultEnabled: true,
});

/**
 * Resolve a persisted hotkey blob (or anything) into a valid
 * {@link ChatOverlayHotkey}, falling back to the default accelerator/enabled
 * state for missing or malformed fields.
 */
export function resolveChatOverlayHotkey(value: unknown): ChatOverlayHotkey {
  return chatOverlayHotkeyStore.resolve(value);
}

export function getChatOverlayHotkey(): ChatOverlayHotkey {
  return chatOverlayHotkeyStore.get();
}

export function setChatOverlayHotkey(next: Partial<ChatOverlayHotkey>): void {
  chatOverlayHotkeyStore.set(next);
}

export function useChatOverlayHotkey(): ChatOverlayHotkey {
  return useSyncExternalStore(
    chatOverlayHotkeyStore.subscribe,
    chatOverlayHotkeyStore.get,
    chatOverlayHotkeyStore.getDefault,
  );
}
