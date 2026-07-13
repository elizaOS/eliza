/**
 * Desktop settings controls for the programmable global hotkeys, embedded in
 * the Desktop Workspace section: chat-overlay summon (#10716), the
 * voice-conversation toggle, and the transcription toggle. One generic
 * enable-toggle + keystroke-recorder group is instantiated per hotkey store;
 * each persists through its store and re-registers the OS shortcut through the
 * desktop bridge so a change takes effect without relaunching the shell.
 */

import { Keyboard, type LucideIcon, Mic, ScrollText } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { invokeDesktopBridgeRequest } from "../../bridge";
import { useAppSelector } from "../../state";
import {
  acceleratorFromKeyboardEvent,
  type DesktopHotkeyStore,
  TRANSCRIBE_SHORTCUT_ID,
  transcribeHotkeyStore,
  VOICE_SHORTCUT_ID,
  voiceHotkeyStore,
} from "../../state/desktop-hotkeys";
import { chatOverlayHotkeyStore } from "../../state/useChatOverlayHotkey";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsGroup, SettingsRow } from "./settings-layout";

/**
 * Push a hotkey's current accelerator to the desktop shell so a change takes
 * effect without a relaunch: unregister the old binding, then register the new
 * one when enabled. Best-effort — a bridge failure leaves the persisted setting
 * untouched and is surfaced to the caller.
 */
async function syncDesktopShortcut(
  shortcutId: string,
  accelerator: string,
  enabled: boolean,
): Promise<void> {
  await invokeDesktopBridgeRequest<void>({
    rpcMethod: "desktopUnregisterShortcut",
    ipcChannel: "desktop:unregisterShortcut",
    params: { id: shortcutId },
  });
  if (enabled) {
    const result = await invokeDesktopBridgeRequest<{ success: boolean }>({
      rpcMethod: "desktopRegisterShortcut",
      ipcChannel: "desktop:registerShortcut",
      params: { id: shortcutId, accelerator },
    });
    if (result?.success === false) {
      throw new Error(
        `The operating system rejected ${accelerator}. Choose a different shortcut.`,
      );
    }
  }
}

interface HotkeyGroupCopy {
  title: string;
  description: string;
  enableLabel: string;
  enableDescription: string;
}

/** Enable toggle plus a keystroke recorder that captures the next key
 * combination as the hotkey's accelerator. Generic over the store + shortcut
 * id so chat/voice/transcribe stay one implementation. */
function DesktopHotkeySettingsGroup({
  store,
  shortcutId,
  icon,
  i18nPrefix,
  copy,
}: {
  store: DesktopHotkeyStore;
  shortcutId: string;
  icon: LucideIcon;
  /** i18n key prefix, e.g. `desktopworkspacesection.chatHotkey`. */
  i18nPrefix: string;
  copy: HotkeyGroupCopy;
}) {
  const t = useAppSelector((s) => s.t);
  const hotkey = useSyncExternalStore(
    store.subscribe,
    store.get,
    store.getDefault,
  );
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback(
    async (accelerator: string, enabled: boolean) => {
      try {
        await syncDesktopShortcut(shortcutId, accelerator, enabled);
        store.set({ accelerator, enabled });
        setError(null);
      } catch (syncError) {
        setError(
          syncError instanceof Error ? syncError.message : String(syncError),
        );
      }
    },
    [shortcutId, store],
  );

  useEffect(() => {
    if (!recording) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      if (event.key === "Escape") {
        setRecording(false);
        return;
      }
      const accelerator = acceleratorFromKeyboardEvent(event);
      if (!accelerator) {
        return;
      }
      setRecording(false);
      void apply(accelerator, hotkey.enabled);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, apply, hotkey.enabled]);

  const Icon = icon;
  return (
    <SettingsGroup
      title={t(`${i18nPrefix}.title`, { defaultValue: copy.title })}
      description={t(`${i18nPrefix}.description`, {
        defaultValue: copy.description,
      })}
    >
      <SettingsRow
        icon={Icon}
        label={t(`${i18nPrefix}.enableLabel`, {
          defaultValue: copy.enableLabel,
        })}
        description={t(`${i18nPrefix}.enableDescription`, {
          defaultValue: copy.enableDescription,
        })}
        control={
          <Switch
            checked={hotkey.enabled}
            onCheckedChange={(checked) =>
              void apply(hotkey.accelerator, checked)
            }
            aria-label={t(`${i18nPrefix}.enableLabel`, {
              defaultValue: copy.enableLabel,
            })}
          />
        }
      />
      <SettingsRow
        label={t(`${i18nPrefix}.shortcutLabel`, {
          defaultValue: "Shortcut",
        })}
        description={
          recording
            ? t(`${i18nPrefix}.recording`, {
                defaultValue: "Press a key combination… (Esc to cancel)",
              })
            : hotkey.accelerator
        }
        control={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!hotkey.enabled}
              onClick={() => {
                setError(null);
                setRecording((current) => !current);
              }}
            >
              {recording
                ? t(`${i18nPrefix}.listening`, {
                    defaultValue: "Listening…",
                  })
                : t(`${i18nPrefix}.record`, {
                    defaultValue: "Record",
                  })}
            </Button>
            {hotkey.accelerator !== store.defaultHotkey.accelerator && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  void apply(store.defaultHotkey.accelerator, hotkey.enabled)
                }
              >
                {t(`${i18nPrefix}.reset`, {
                  defaultValue: "Reset",
                })}
              </Button>
            )}
          </div>
        }
      />
      {error && (
        <div
          className="rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
          role="alert"
        >
          {error}
        </div>
      )}
    </SettingsGroup>
  );
}

/** Chat-overlay summon hotkey (#10716) — shortcut id `chat-overlay`. */
export function ChatHotkeySettingsGroup() {
  return (
    <DesktopHotkeySettingsGroup
      store={chatOverlayHotkeyStore}
      shortcutId="chat-overlay"
      icon={Keyboard}
      i18nPrefix="desktopworkspacesection.chatHotkey"
      copy={{
        title: "Chat Summon Hotkey",
        description:
          "A global keyboard shortcut that brings the floating chat surface to the foreground.",
        enableLabel: "Enable chat summon hotkey",
        enableDescription:
          "The command palette keeps ⌘/Ctrl+K; this is a separate shortcut.",
      }}
    />
  );
}

/** Voice-conversation toggle hotkey — shortcut id `voice`; the press summons
 * the window and flips the hands-free conversation loop. */
export function VoiceHotkeySettingsGroup() {
  return (
    <DesktopHotkeySettingsGroup
      store={voiceHotkeyStore}
      shortcutId={VOICE_SHORTCUT_ID}
      icon={Mic}
      i18nPrefix="desktopworkspacesection.voiceHotkey"
      copy={{
        title: "Voice Conversation Hotkey",
        description:
          "A global keyboard shortcut that summons the window and starts (or ends) a hands-free voice conversation.",
        enableLabel: "Enable voice conversation hotkey",
        enableDescription:
          "Press once to start talking, press again to end the conversation.",
      }}
    />
  );
}

/** Transcription toggle hotkey — shortcut id `transcribe`; disabled by default. */
export function TranscribeHotkeySettingsGroup() {
  return (
    <DesktopHotkeySettingsGroup
      store={transcribeHotkeyStore}
      shortcutId={TRANSCRIBE_SHORTCUT_ID}
      icon={ScrollText}
      i18nPrefix="desktopworkspacesection.transcribeHotkey"
      copy={{
        title: "Transcription Hotkey",
        description:
          "A global keyboard shortcut that summons the window and toggles long-form transcription capture.",
        enableLabel: "Enable transcription hotkey",
        enableDescription:
          "Off by default. Transcription records without agent replies until toggled off.",
      }}
    />
  );
}
