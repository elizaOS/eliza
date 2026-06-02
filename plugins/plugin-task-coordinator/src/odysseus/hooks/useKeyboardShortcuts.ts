// Global keyboard shortcuts for the odysseus port — a faithful TS port of
// static/js/keyboard-shortcuts.js + platform.js combo matching, adapted from
// odysseus's DOM-button-click model to the clone's React state-callback model.
//
// odysseus initKeyboardShortcuts() fires actions by clicking the matching
// sidebar/tool button; the clone instead drives its own setX state setters, so
// this hook takes a typed handler map and only binds the actions whose handler
// the caller actually provides. Behaviour preserved: a single window keydown
// listener (cleaned up on unmount), AltGr-safe combo matching (drop keystrokes
// that assert the AltGraph modifier state on non-mac, per platform.js, so
// typing @ # { } on a non-US layout can't fire a Ctrl+Alt shortcut),
// preventDefault on a match, and shortcuts that never fire while focus sits in
// an input/textarea/contenteditable — with focusInput the one exception, so a
// user can re-grab the composer from anywhere.

import { useEffect, useRef } from "react";

// ── Bindable actions, mapped to the surfaces the clone HAS. Each is the combo
//    string odysseus uses (focus_input/settings/toggle_sidebar/new_session/
//    open_calendar) or the open_<tool> naming for the per-tool set. Matching is
//    case-insensitive on the final key, exactly like _matchesCombo.
export interface KeyboardShortcutHandlers {
  toggleSidebar?: () => void;
  newSession?: () => void;
  focusInput?: () => void;
  openSettings?: () => void;
  openCalendar?: () => void;
  openCompare?: () => void;
  openCookbook?: () => void;
  openResearch?: () => void;
  openGallery?: () => void;
  openMemory?: () => void;
  openNotes?: () => void;
  openTasks?: () => void;
  openModels?: () => void;
  openTheme?: () => void;
}

type ShortcutAction = keyof KeyboardShortcutHandlers;

// Default keybinds, mirroring static/js/keyboard-shortcuts.js `_defaultKeybinds`.
// odysseus leaves most open_* combos empty (bound only via settings); the clone
// has no per-action settings surface yet, so each tool gets a stable Ctrl+Alt
// default in the spirit of the bound calendar shortcut. focusInput stays Ctrl+/
// and settings Ctrl+, exactly as odysseus ships them.
const KEYBINDS: Record<ShortcutAction, string> = {
  toggleSidebar: "ctrl+alt+b",
  newSession: "ctrl+alt+n",
  focusInput: "ctrl+/",
  openSettings: "ctrl+,",
  openCalendar: "ctrl+alt+c",
  openCompare: "ctrl+alt+p",
  openCookbook: "ctrl+alt+k",
  openResearch: "ctrl+alt+r",
  openGallery: "ctrl+alt+g",
  openMemory: "ctrl+alt+m",
  openNotes: "ctrl+alt+o",
  openTasks: "ctrl+alt+t",
  openModels: "ctrl+alt+l",
  openTheme: "ctrl+alt+h",
} as const;

// Mirrors platform.js IS_MAC: all Apple platforms (Magic Keyboard Option also
// sets AltGraph), matching the existing isMac checks in calendar.js/sessions.js.
function detectIsMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform || "";
  const ua = navigator.userAgent || "";
  return /Mac|iPhone|iPad/.test(platform) || /Mac/.test(ua);
}

// platform.js isAltGrEvent: true only when a non-mac event presents AS Ctrl+Alt
// AND asserts the AltGraph modifier state — i.e. the AltGr collision we drop.
// An event that asserts AltGraph without Ctrl+Alt (ISO_Level3_Shift, a stray
// modifier) is deliberately left alone. Always false on mac, where Option
// legitimately sets AltGraph.
function isAltGrEvent(e: KeyboardEvent, isMac: boolean): boolean {
  return (
    !isMac &&
    e.ctrlKey &&
    e.altKey &&
    typeof e.getModifierState === "function" &&
    e.getModifierState("AltGraph")
  );
}

// Port of _matchesCombo: split on '+', require exact ctrl/alt/shift state
// (ctrl satisfied by either Ctrl or Meta, as odysseus treats Cmd as Ctrl), and
// compare the remaining key case-insensitively. AltGr keystrokes never match.
function matchesCombo(
  e: KeyboardEvent,
  combo: string,
  isMac: boolean,
): boolean {
  if (!combo) return false;
  if (isAltGrEvent(e, isMac)) return false;
  const parts = combo.split("+");
  const needCtrl = parts.includes("ctrl");
  const needAlt = parts.includes("alt");
  const needShift = parts.includes("shift");
  const key =
    parts.find((p) => p !== "ctrl" && p !== "alt" && p !== "shift") ?? "";
  if (needCtrl !== (e.ctrlKey || e.metaKey)) return false;
  if (needAlt !== e.altKey) return false;
  if (needShift !== e.shiftKey) return false;
  return e.key.toLowerCase() === key;
}

// True when focus sits in a text-entry surface — input, textarea, or any
// contenteditable element. Shortcuts (except focusInput) stay inert here so a
// Ctrl+, typed into the composer never steals the keystroke.
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  return target.isContentEditable;
}

// The order odysseus checks bindings in: structural surfaces first, then the
// per-tool open set, with focusInput last (matching the source's final clause).
const ACTION_ORDER: readonly ShortcutAction[] = [
  "toggleSidebar",
  "newSession",
  "openSettings",
  "openCalendar",
  "openCompare",
  "openCookbook",
  "openResearch",
  "openGallery",
  "openMemory",
  "openNotes",
  "openTasks",
  "openModels",
  "openTheme",
  "focusInput",
] as const;

/**
 * Bind a single global keydown listener for the odysseus shortcut set. Only
 * actions whose handler is supplied are matched; everything else is ignored.
 * The listener is bound once and reads the latest `handlers` via a ref, so
 * changing the handler closures never re-adds it; it is removed on unmount.
 */
export function useKeyboardShortcuts(handlers: KeyboardShortcutHandlers): void {
  // Keep the latest handlers in a ref so the effect can bind once and never
  // tear down/re-add the listener as the caller's closures change each render.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const isMac = detectIsMac();
    const onKeyDown = (e: KeyboardEvent): void => {
      const current = handlersRef.current;
      const editable = isEditableTarget(e.target);
      for (const action of ACTION_ORDER) {
        const handler = current[action];
        if (!handler) continue;
        if (!matchesCombo(e, KEYBINDS[action], isMac)) continue;
        // While focus is in a text field, only focusInput is allowed to fire.
        if (editable && action !== "focusInput") continue;
        e.preventDefault();
        handler();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
