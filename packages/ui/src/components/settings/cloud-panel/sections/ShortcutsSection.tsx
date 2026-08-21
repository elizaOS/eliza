/**
 * Shortcuts section for the cloud-only desktop settings panel. Surfaces global
 * hotkeys (with an in-place keystroke recorder and conflict detection), mouse
 * shortcut configuration, and the long-recording cancel confirmation threshold.
 *
 * The shortcut definitions mirror the accelerator strings used by the Electrobun
 * application menu (`app-core/platforms/electrobun/src/application-menu.ts`).
 * Bindings are held in local state for now — the desktop RPC to re-register a
 * global shortcut from this surface does not exist yet (see `useChatOverlayHotkey`
 * for the one shortcut that already has a live bridge). When that RPC lands,
 * `commitCombo`/`resetCombo` are the single call sites to wire it through.
 */

import { AlertTriangle, Keyboard, Mouse, RotateCcw } from "lucide-react";
import * as React from "react";
import { cn } from "../../../../lib/utils";
import {
  SettingsGroup,
  SettingsStack,
  NuphySwitchRow,
  NuphySelectRow,
  NuphyRow,
} from "../nuphy-settings-primitives";
import { Button as NuphyButton } from "@extrastu/nuphy-ui";

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

// Defaults mirror the accelerators in application-menu.ts and the spec table.
const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  {
    id: "toggle-recording",
    label: "Toggle recording",
    defaultCombo: "alt+space",
    combo: "alt+space",
  },
  {
    id: "push-to-talk",
    label: "Push to talk",
    defaultCombo: "cmd+r",
    combo: "cmd+r",
  },
  {
    id: "cancel-recording",
    label: "Cancel recording",
    defaultCombo: "escape",
    combo: "escape",
  },
  {
    id: "change-mode",
    label: "Change mode",
    defaultCombo: "alt+shift+k",
    combo: "alt+shift+k",
  },
  {
    id: "open-eliza",
    label: "Open Eliza",
    defaultCombo: "cmd+shift+e",
    combo: "cmd+shift+e",
  },
  {
    id: "show-settings",
    label: "Show settings",
    defaultCombo: "cmd+,",
    combo: "cmd+,",
  },
  {
    id: "secrets-storage",
    label: "Secrets storage",
    defaultCombo: "cmd+alt+ctrl+v",
    combo: "cmd+alt+ctrl+v",
  },
];

const CLICK_ACTION_OPTIONS = [
  { value: "toggle-recording", label: "Toggle recording" },
  { value: "push-to-talk", label: "Push to talk" },
  { value: "open-eliza", label: "Open Eliza" },
  { value: "none", label: "None" },
];

const HOLD_ACTION_OPTIONS = [
  { value: "push-to-talk", label: "Push to talk" },
  { value: "toggle-recording", label: "Toggle recording" },
  { value: "none", label: "None" },
];

const THRESHOLD_OPTIONS = [
  { value: "10", label: "10 seconds" },
  { value: "20", label: "20 seconds" },
  { value: "30", label: "30 seconds" },
  { value: "60", label: "60 seconds" },
];

export function ShortcutsSection() {
  const [shortcuts, setShortcuts] =
    React.useState<ShortcutBinding[]>(DEFAULT_SHORTCUTS);
  const [recordingId, setRecordingId] = React.useState<string | null>(null);
  // A captured combo awaiting conflict resolution before it is committed.
  const [pending, setPending] = React.useState<{
    id: string;
    combo: Combo;
  } | null>(null);

  // Mouse shortcut config — local state; desktop RPC for mouse buttons is new.
  const [mouseEnabled, setMouseEnabled] = React.useState(false);
  const [clickAction, setClickAction] = React.useState("toggle-recording");
  const [holdAction, setHoldAction] = React.useState("push-to-talk");

  // Long-recording cancel confirmation — persisted to the app store when wired.
  const [confirmCancel, setConfirmCancel] = React.useState(true);
  const [threshold, setThreshold] = React.useState("30");

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

  const commitCombo = React.useCallback((id: string, combo: Combo) => {
    setShortcuts((prev) =>
      prev.map((s) => (s.id === id ? { ...s, combo } : s)),
    );
    setPending(null);
    // NOTE: the desktop RPC to unregister the old global shortcut and register
    // the new one does not exist yet for these bindings. When it lands, call it
    // here (see ChatHotkeySettingsGroup.syncChatOverlayShortcut for the shape).
  }, []);

  const resetCombo = React.useCallback(
    (id: string) => {
      const def = DEFAULT_SHORTCUTS.find((s) => s.id === id);
      if (def) commitCombo(id, def.defaultCombo);
    },
    [commitCombo],
  );

  // Override: assign the combo to this shortcut and reset the displaced one to
  // its default so the two never silently share a binding.
  const overrideConflict = React.useCallback(
    (id: string, combo: Combo, conflictId: string) => {
      const conflictDef = DEFAULT_SHORTCUTS.find((s) => s.id === conflictId);
      setShortcuts((prev) =>
        prev.map((s) => {
          if (s.id === id) return { ...s, combo };
          if (s.id === conflictId && conflictDef)
            return { ...s, combo: conflictDef.defaultCombo };
          return s;
        }),
      );
      setPending(null);
      // NOTE: wire desktop shortcut re-registration here once the RPC exists.
    },
    [],
  );

  const conflict = pending
    ? findConflict(pending.id, pending.combo)
    : undefined;

  return (
    <SettingsStack>
      <SettingsGroup
        title="Global Shortcuts"
        footer="Global hotkeys. Click ⌨ to record a new key combination."
      >
        {shortcuts.map((shortcut) => {
          const isRecording = recordingId === shortcut.id;
          const isPending = pending?.id === shortcut.id;
          const conflictForThis = isPending ? conflict : undefined;
          return (
            <NuphyRow
              key={shortcut.id}
              label={shortcut.label}
              description={
                isRecording ? "Press keys… (Esc to cancel)" : undefined
              }
            >
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "min-w-[3.5rem] rounded-sm border border-hairline bg-surface px-2 py-1 text-center font-mono text-xs tabular-nums text-foreground",
                      isRecording && "border-accent/60 text-muted-foreground",
                    )}
                  >
                    {isRecording ? "…" : formatCombo(shortcut.combo)}
                  </span>
                  <NuphyButton
                    type="button"
                    variant={isRecording ? "primary" : "secondary"}
                    size="sm"
                    aria-label={`Record ${shortcut.label} shortcut`}
                    onClick={() => {
                      setPending(null);
                      setRecordingId(isRecording ? null : shortcut.id);
                    }}
                  >
                    <Keyboard className="h-4 w-4" aria-hidden />
                  </NuphyButton>
                  <NuphyButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Reset ${shortcut.label} shortcut`}
                    disabled={shortcut.combo === shortcut.defaultCombo}
                    onClick={() => resetCombo(shortcut.id)}
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden />
                  </NuphyButton>
                </div>
                {isPending && conflictForThis ? (
                  <div
                    className="mt-2 flex flex-wrap items-center gap-2 rounded-sm border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
                    role="alert"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="flex-1">
                      This combo is used by “{conflictForThis.label}”. Override?
                    </span>
                    <NuphyButton
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={() =>
                        overrideConflict(
                          shortcut.id,
                          pending.combo,
                          conflictForThis.id,
                        )
                      }
                    >
                      Override
                    </NuphyButton>
                    <NuphyButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setPending(null)}
                    >
                      Cancel
                    </NuphyButton>
                  </div>
                ) : null}
              </div>
            </NuphyRow>
          );
        })}
      </SettingsGroup>

      <SettingsGroup
        title="Mouse"
        footer="Use a mouse button as a recording trigger."
      >
        <NuphySwitchRow
          agentId="shortcuts-mouse-enabled"
          group="shortcuts"
          icon={Mouse}
          label="Mouse shortcut"
          description="Enable a mouse button as a shortcut trigger."
          checked={mouseEnabled}
          onCheckedChange={setMouseEnabled}
        />
        <NuphySelectRow
          agentId="shortcuts-mouse-click-action"
          group="shortcuts"
          label="Click action"
          description="What a quick click does."
          value={clickAction}
          onValueChange={setClickAction}
          options={CLICK_ACTION_OPTIONS}
          disabled={!mouseEnabled}
        />
        <NuphySelectRow
          agentId="shortcuts-mouse-hold-action"
          group="shortcuts"
          label="Hold action"
          description="What a click-and-hold does."
          value={holdAction}
          onValueChange={setHoldAction}
          options={HOLD_ACTION_OPTIONS}
          disabled={!mouseEnabled}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Recording"
        footer="Protect against accidentally discarding long recordings."
      >
        <NuphySwitchRow
          agentId="shortcuts-confirm-cancel-long"
          group="shortcuts"
          label="Confirm cancel on long recordings"
          description="Show a confirmation prompt before cancelling a recording longer than the threshold."
          checked={confirmCancel}
          onCheckedChange={setConfirmCancel}
        />
        {confirmCancel ? (
          <NuphySelectRow
            agentId="shortcuts-cancel-threshold"
            group="shortcuts"
            label="Threshold"
            description="Recordings longer than this trigger a cancel confirmation."
            value={threshold}
            onValueChange={setThreshold}
            options={THRESHOLD_OPTIONS}
          />
        ) : null}
      </SettingsGroup>
    </SettingsStack>
  );
}
