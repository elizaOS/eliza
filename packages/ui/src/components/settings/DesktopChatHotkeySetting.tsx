import { Keyboard } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  acceleratorFromKeyboardEvent,
  currentPlatform,
  type DesktopHotkeySettings,
  defaultChatSummonAccelerator,
  formatAcceleratorForDisplay,
  isSafeGlobalAccelerator,
  loadDesktopHotkeySettings,
  resolveChatSummonAccelerator,
  saveDesktopHotkeySettings,
} from "../../utils/desktop-hotkey";
import { Button } from "../ui/button";

/** Event the renderer shell listens for to re-register the global shortcut. */
const HOTKEY_CHANGED_EVENT = "eliza:desktop:hotkey-changed";

function announceChange(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(HOTKEY_CHANGED_EVENT));
  }
}

/**
 * Desktop-settings control for the programmable global chat hotkey (#10716).
 * Records a keystroke, validates it as a safe global accelerator, persists it,
 * and asks the shell to re-register — mirroring Claude Desktop's hotkey field.
 */
export function DesktopChatHotkeySetting({
  className = "",
  platform: platformProp,
}: {
  className?: string;
  /** Overridable for deterministic tests; defaults to the detected OS. */
  platform?: NodeJS.Platform;
}) {
  const [settings, setSettings] = useState<DesktopHotkeySettings>(() =>
    loadDesktopHotkeySettings(),
  );
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const platform = platformProp ?? currentPlatform();
  const effective = resolveChatSummonAccelerator(settings, platform);
  const isCustom = settings.chatSummonAccelerator !== null;

  const commit = useCallback((next: DesktopHotkeySettings) => {
    const stored = saveDesktopHotkeySettings(next);
    setSettings(stored);
    announceChange();
  }, []);

  useEffect(() => {
    if (!recording) return;

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(false);
        setError(null);
        return;
      }
      const accelerator = acceleratorFromKeyboardEvent(event);
      if (!accelerator) return; // modifier-only or unsupported — keep listening
      if (!isSafeGlobalAccelerator(accelerator)) {
        setError(
          "Pick a combination with ⌘/Ctrl/Alt (a bare or Shift-only key would hijack typing).",
        );
        return;
      }
      commit({ chatSummonAccelerator: accelerator });
      setRecording(false);
      setError(null);
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [recording, commit]);

  const defaultLabel = formatAcceleratorForDisplay(
    defaultChatSummonAccelerator(platform),
    platform,
  );

  return (
    <div
      className={`rounded-lg border border-border bg-card px-4 py-3 ${className}`}
    >
      <div className="flex items-start gap-3">
        <Keyboard className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-txt">Summon chat hotkey</div>
          <p className="mt-0.5 text-xs text-muted">
            Global shortcut that brings the floating chat to the foreground from
            any app — even when the desktop window is in the background.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <kbd
              className="rounded-sm border border-border bg-bg px-2 py-1 font-mono text-xs text-txt"
              data-testid="chat-hotkey-current"
            >
              {recording
                ? "Press keys…"
                : formatAcceleratorForDisplay(effective, platform)}
            </kbd>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setError(null);
                setRecording((value) => !value);
              }}
              data-testid="chat-hotkey-record"
            >
              {recording ? "Cancel" : "Change"}
            </Button>
            {isCustom && !recording ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => commit({ chatSummonAccelerator: null })}
                data-testid="chat-hotkey-reset"
              >
                Reset to default ({defaultLabel})
              </Button>
            ) : null}
          </div>
          {error ? (
            <p className="mt-2 text-xs text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
