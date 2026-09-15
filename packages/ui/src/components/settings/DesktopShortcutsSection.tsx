/**
 * Native Shortcuts module for the canonical Settings registry. Surfaces global
 * hotkeys with an in-place keystroke recorder and conflict detection.
 *
 * The shortcut definitions mirror the accelerator strings used by the Electrobun
 * application menu (`app-core/platforms/electrobun/src/application-menu.ts`).
 * Bindings are re-registered through the desktop bridge (`desktop:registerShortcut`
 * / `desktop:unregisterShortcut`) on commit/reset, following the same pattern as
 * `ChatHotkeySettingsGroup.syncChatOverlayShortcut`.
 */

import { ElizaError } from "@elizaos/core";
import { AlertTriangle, Keyboard, RotateCcw } from "lucide-react";
import * as React from "react";
import { invokeDesktopBridgeRequest } from "../../bridge";
import { cn } from "../../lib/utils";
import {
  DEFAULT_PUSH_TO_TALK_ACCELERATOR,
  getPushToTalkAccelerator,
  setPushToTalkAccelerator,
} from "../../state/push-to-talk-hotkey";
import { SettingsActionButton } from "./settings-agent-rows";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

/** Internal canonical combo form: lowercase modifier names + key, joined by `+`. */
type Combo = string;

interface ShortcutBinding {
  id: string;
  label: string;
  /** Canonical default combo (used by the ↺ reset button). */
  defaultCombo: Combo;
  /** Current canonical combo. */
  combo: Combo;
}

// Display symbols for modifiers — matches the spec's ⌘/⌥/⌃/⇧ notation.
const MODIFIER_SYMBOLS: Record<string, string> = {
  cmd: "⌘",
  alt: "⌥",
  ctrl: "⌃",
  shift: "⇧",
};

// Named keys rendered with a friendlier label than the raw `event.key`.
const KEY_LABELS: Record<string, string> = {
  escape: "esc",
  space: "Space",
  enter: "↵",
  backspace: "⌫",
  tab: "⇥",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

// `event.key` values that are pure modifiers — pressing one alone is not a bind.
const MODIFIER_KEYS = new Set(["control", "alt", "shift", "meta"]);

/** Render a canonical combo as the human-facing ⌘ ⇧ E style string. */
function formatCombo(combo: Combo): string {
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const keyLabel =
    KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return [...mods.map((m) => MODIFIER_SYMBOLS[m] ?? m), keyLabel].join(" ");
}

/** Convert a captured keyboard event into a canonical combo, or null if it
 * carries only modifiers / a bare printable char with no modifier. */
function comboFromKeyboardEvent(event: KeyboardEvent): Combo | null {
  const key = event.key.toLowerCase();
  if (MODIFIER_KEYS.has(key)) return null;
  const hasModifier =
    event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
  // A bare single printable character with no modifier would hijack that key
  // globally — reject it. Named keys (Space, Escape, F-keys) may bind alone.
  if (key.length === 1 && !hasModifier) return null;
  const parts: string[] = [];
  if (event.metaKey) parts.push("cmd");
  if (event.ctrlKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

/** Convert a canonical combo ("cmd+shift+e") to an Electrobun accelerator
 * string ("CommandOrControl+Shift+E"). Mirrors `acceleratorFromKeyboardEvent`
 * from `useChatOverlayHotkey` but works on the stored combo format. */
function comboToAccelerator(combo: Combo): string {
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const out: string[] = [];
  if (mods.includes("cmd") || mods.includes("ctrl"))
    out.push("CommandOrControl");
  if (mods.includes("alt")) out.push("Alt");
  if (mods.includes("shift")) out.push("Shift");
  const keyLabel =
    key.length === 1
      ? key.toUpperCase()
      : key.charAt(0).toUpperCase() + key.slice(1);
  out.push(keyLabel);
  return out.join("+");
}

/** Convert an Electrobun accelerator into the recorder's canonical combo. */
function acceleratorToCombo(accelerator: string): Combo {
  return accelerator
    .split("+")
    .map((part) => {
      const token = part.toLowerCase();
      if (token === "commandorcontrol") return "cmd";
      if (token === "control") return "ctrl";
      return token;
    })
    .join("+");
}

/** Replace a shortcut through the desktop bridge's transactional registration boundary. */
async function syncShortcut(id: string, combo: Combo): Promise<void> {
  const accelerator = comboToAccelerator(combo);
  const result = await invokeDesktopBridgeRequest<{ success: boolean }>({
    rpcMethod: "desktopRegisterShortcut",
    ipcChannel: "desktop:registerShortcut",
    params: { id, accelerator },
  });
  if (result?.success !== true) {
    const message = result
      ? `The operating system rejected ${accelerator}. Choose a different shortcut.`
      : `The desktop app did not register ${accelerator}. Restart Eliza and try again.`;
    throw new ElizaError(message, {
      code: result
        ? "DESKTOP_SHORTCUT_REJECTED"
        : "DESKTOP_SHORTCUT_METHOD_UNAVAILABLE",
      context: { id, accelerator },
    });
  }
}

// Only expose shortcuts with a complete native registration -> renderer action
// contract. Other menu accelerators remain owned by application-menu.ts until
// they gain an equivalent dynamic dispatcher.
const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  {
    id: "push-to-talk",
    label: "Push to talk",
    defaultCombo: acceleratorToCombo(DEFAULT_PUSH_TO_TALK_ACCELERATOR),
    combo: acceleratorToCombo(DEFAULT_PUSH_TO_TALK_ACCELERATOR),
  },
];

export function DesktopShortcutsSection() {
  const [shortcuts, setShortcuts] = React.useState<ShortcutBinding[]>(() =>
    DEFAULT_SHORTCUTS.map((shortcut) =>
      shortcut.id === "push-to-talk"
        ? {
            ...shortcut,
            combo: acceleratorToCombo(getPushToTalkAccelerator()),
          }
        : shortcut,
    ),
  );
  const [recordingId, setRecordingId] = React.useState<string | null>(null);
  // A captured combo awaiting conflict resolution before it is committed.
  const [pending, setPending] = React.useState<{
    id: string;
    combo: Combo;
  } | null>(null);
  const [shortcutError, setShortcutError] = React.useState<string | null>(null);
  const [shortcutMutationPending, setShortcutMutationPending] =
    React.useState(false);
  const mutationInFlight = React.useRef(false);

  const findConflict = React.useCallback(
    (id: string, combo: Combo): ShortcutBinding | undefined =>
      shortcuts.find((s) => s.id !== id && s.combo === combo),
    [shortcuts],
  );

  // Capture mode: while a row is recording, the next valid key combo is grabbed.
  // Esc cancels capture without saving (and is not itself recorded).
  React.useEffect(() => {
    if (!recordingId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecordingId(null);
        return;
      }
      const combo = comboFromKeyboardEvent(event);
      if (!combo) return;
      setRecordingId(null);
      setPending({ id: recordingId, combo });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recordingId]);

  const commitCombo = React.useCallback(
    async (id: string, combo: Combo) => {
      if (mutationInFlight.current) return;
      mutationInFlight.current = true;
      setShortcutMutationPending(true);
      const previousCombo = shortcuts.find(
        (shortcut) => shortcut.id === id,
      )?.combo;
      try {
        await syncShortcut(id, combo);
        if (id === "push-to-talk") {
          try {
            setPushToTalkAccelerator(comboToAccelerator(combo));
          } catch (persistenceError) {
            // error-policy:J2 persistence failure rethrows with cause after a
            // best-effort rollback to the previous shortcut.
            if (previousCombo) {
              try {
                await syncShortcut(id, previousCombo);
              } catch (rollbackError) {
                // error-policy:J2 rollback failure rethrows with both causes.
                throw new ElizaError(
                  "The shortcut changed but could not be saved or restored. Restart Eliza to restore the saved shortcut.",
                  {
                    code: "DESKTOP_SHORTCUT_PERSISTENCE_AND_ROLLBACK_FAILED",
                    cause: new AggregateError([
                      persistenceError,
                      rollbackError,
                    ]),
                    context: { id, combo, previousCombo },
                  },
                );
              }
            }
            throw new ElizaError(
              "The shortcut could not be saved, so the previous shortcut was restored.",
              {
                code: "DESKTOP_SHORTCUT_PERSISTENCE_FAILED",
                cause: persistenceError,
                context: { id, combo, previousCombo },
              },
            );
          }
        }
        setShortcuts((prev) =>
          prev.map((s) => (s.id === id ? { ...s, combo } : s)),
        );
        setPending(null);
        setShortcutError(null);
      } catch (error) {
        // error-policy:J4 commit failure renders the visible shortcut error.
        setPending(null);
        setShortcutError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        mutationInFlight.current = false;
        setShortcutMutationPending(false);
      }
    },
    [shortcuts],
  );

  const resetCombo = React.useCallback(
    (id: string) => {
      const def = DEFAULT_SHORTCUTS.find((s) => s.id === id);
      if (def) void commitCombo(id, def.defaultCombo);
    },
    [commitCombo],
  );

  // Override: assign the combo to this shortcut and reset the displaced one to
  // its default so the two never silently share a binding.
  const overrideConflict = React.useCallback(
    async (id: string, combo: Combo, conflictId: string) => {
      const current = shortcuts.find((shortcut) => shortcut.id === id);
      const conflictDef = DEFAULT_SHORTCUTS.find((s) => s.id === conflictId);
      if (!current || !conflictDef) return;
      if (mutationInFlight.current) return;
      mutationInFlight.current = true;
      setShortcutMutationPending(true);
      try {
        await syncShortcut(id, combo);
        try {
          await syncShortcut(conflictId, conflictDef.defaultCombo);
        } catch (conflictError) {
          // error-policy:J2 conflict-reset failure restores the original
          // binding and rethrows for the outer visible-error boundary.
          await syncShortcut(id, current.combo);
          throw conflictError;
        }
        setShortcuts((prev) =>
          prev.map((s) => {
            if (s.id === id) return { ...s, combo };
            if (s.id === conflictId)
              return { ...s, combo: conflictDef.defaultCombo };
            return s;
          }),
        );
        setPending(null);
        setShortcutError(null);
      } catch (error) {
        // error-policy:J4 override failure renders the visible shortcut error.
        setPending(null);
        setShortcutError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        mutationInFlight.current = false;
        setShortcutMutationPending(false);
      }
    },
    [shortcuts],
  );

  const conflict = pending
    ? findConflict(pending.id, pending.combo)
    : undefined;

  React.useEffect(() => {
    if (pending && !conflict) void commitCombo(pending.id, pending.combo);
  }, [commitCombo, conflict, pending]);

  return (
    <SettingsStack>
      <SettingsGroup
        title="Global Shortcuts"
        footer="Global hotkeys. Click ⌨ to record a new key combination."
      >
        {shortcutError ? (
          <div
            className="my-2 rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            role="alert"
          >
            {shortcutError}
          </div>
        ) : null}
        {shortcuts.map((shortcut) => {
          const isRecording = recordingId === shortcut.id;
          const isPending = pending?.id === shortcut.id;
          const conflictForThis = isPending ? conflict : undefined;
          return (
            <SettingsRow
              key={shortcut.id}
              label={shortcut.label}
              description={
                isRecording ? "Press keys… (Esc to cancel)" : undefined
              }
              control={
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "min-w-[3.5rem] rounded-sm border border-border bg-surface px-2 py-1 text-center font-mono text-xs tabular-nums text-foreground",
                        isRecording && "border-accent/60 text-muted-foreground",
                      )}
                    >
                      {isRecording ? "…" : formatCombo(shortcut.combo)}
                    </span>
                    <SettingsActionButton
                      agentId={`shortcut-${shortcut.id}-record`}
                      agentLabel={`${isRecording ? "Cancel recording" : "Record"} ${shortcut.label} shortcut`}
                      agentDescription={`Capture a new keyboard shortcut for ${shortcut.label}.`}
                      agentGroup="shortcuts"
                      type="button"
                      variant={isRecording ? "default" : "outline"}
                      size="sm"
                      disabled={shortcutMutationPending}
                      onClick={() => {
                        setPending(null);
                        setRecordingId(isRecording ? null : shortcut.id);
                      }}
                    >
                      <Keyboard className="size-4" aria-hidden />
                    </SettingsActionButton>
                    <SettingsActionButton
                      agentId={`shortcut-${shortcut.id}-reset`}
                      agentLabel={`Reset ${shortcut.label} shortcut`}
                      agentDescription={`Restore the default keyboard shortcut for ${shortcut.label}.`}
                      agentGroup="shortcuts"
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={
                        shortcut.combo === shortcut.defaultCombo ||
                        shortcutMutationPending
                      }
                      onClick={() => resetCombo(shortcut.id)}
                    >
                      <RotateCcw className="size-4" aria-hidden />
                    </SettingsActionButton>
                  </div>
                  {isPending && conflictForThis ? (
                    <div
                      className="mt-2 flex flex-wrap items-center gap-2 rounded-sm border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
                      role="alert"
                    >
                      <AlertTriangle
                        className="size-3.5 shrink-0"
                        aria-hidden
                      />
                      <span className="flex-1">
                        This combo is used by “{conflictForThis.label}”.
                        Override?
                      </span>
                      <SettingsActionButton
                        agentId={`shortcut-${shortcut.id}-override`}
                        agentLabel={`Override ${shortcut.label} shortcut conflict`}
                        agentDescription={`Assign the captured shortcut to ${shortcut.label} and restore the conflicting action to its default.`}
                        agentGroup="shortcuts"
                        type="button"
                        variant="default"
                        size="sm"
                        onClick={() =>
                          void overrideConflict(
                            shortcut.id,
                            pending.combo,
                            conflictForThis.id,
                          )
                        }
                        disabled={shortcutMutationPending}
                      >
                        Override
                      </SettingsActionButton>
                      <SettingsActionButton
                        agentId={`shortcut-${shortcut.id}-cancel`}
                        agentLabel={`Cancel ${shortcut.label} shortcut change`}
                        agentDescription={`Discard the captured shortcut for ${shortcut.label}.`}
                        agentGroup="shortcuts"
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setPending(null)}
                      >
                        Cancel
                      </SettingsActionButton>
                    </div>
                  ) : null}
                </div>
              }
            />
          );
        })}
      </SettingsGroup>
    </SettingsStack>
  );
}
