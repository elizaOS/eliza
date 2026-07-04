/**
 * Desktop settings control for the programmable chat-overlay summon hotkey
 * (#10716), embedded in the Desktop Workspace section. Persists the accelerator
 * via `setChatOverlayHotkey` and re-registers the OS shortcut through the
 * desktop bridge so a change takes effect without relaunching the shell.
 */

import { Keyboard } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { invokeDesktopBridgeRequest } from "../../bridge";
import { useAppSelector } from "../../state";
import {
  acceleratorFromKeyboardEvent,
  DEFAULT_CHAT_OVERLAY_ACCELERATOR,
  setChatOverlayHotkey,
  useChatOverlayHotkey,
} from "../../state/useChatOverlayHotkey";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsGroup, SettingsRow } from "./settings-layout";

/**
 * Push the current chat-overlay accelerator to the desktop shell so a change
 * takes effect without a relaunch: unregister the old binding, then register
 * the new one when enabled. Best-effort — a bridge failure leaves the persisted
 * setting untouched and is surfaced to the caller.
 */
async function syncChatOverlayShortcut(
  accelerator: string,
  enabled: boolean,
): Promise<void> {
  await invokeDesktopBridgeRequest<void>({
    rpcMethod: "desktopUnregisterShortcut",
    ipcChannel: "desktop:unregisterShortcut",
    params: { id: "chat-overlay" },
  });
  if (enabled) {
    const result = await invokeDesktopBridgeRequest<{ success: boolean }>({
      rpcMethod: "desktopRegisterShortcut",
      ipcChannel: "desktop:registerShortcut",
      params: { id: "chat-overlay", accelerator },
    });
    if (result?.success === false) {
      throw new Error(
        `The operating system rejected ${accelerator}. Choose a different shortcut.`,
      );
    }
  }
}

/** Enable toggle plus a keystroke recorder that captures the next key
 * combination as the chat-overlay accelerator. */
export function ChatHotkeySettingsGroup() {
  const t = useAppSelector((s) => s.t);
  const hotkey = useChatOverlayHotkey();
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback(async (accelerator: string, enabled: boolean) => {
    try {
      await syncChatOverlayShortcut(accelerator, enabled);
      setChatOverlayHotkey({ accelerator, enabled });
      setError(null);
    } catch (syncError) {
      setError(
        syncError instanceof Error ? syncError.message : String(syncError),
      );
    }
  }, []);

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

  return (
    <SettingsGroup
      title={t("desktopworkspacesection.chatHotkey.title", {
        defaultValue: "Chat Summon Hotkey",
      })}
      description={t("desktopworkspacesection.chatHotkey.description", {
        defaultValue:
          "A global keyboard shortcut that brings the floating chat surface to the foreground.",
      })}
    >
      <SettingsRow
        icon={Keyboard}
        label={t("desktopworkspacesection.chatHotkey.enableLabel", {
          defaultValue: "Enable chat summon hotkey",
        })}
        description={t("desktopworkspacesection.chatHotkey.enableDescription", {
          defaultValue:
            "The command palette keeps ⌘/Ctrl+K; this is a separate shortcut.",
        })}
        control={
          <Switch
            checked={hotkey.enabled}
            onCheckedChange={(checked) =>
              void apply(hotkey.accelerator, checked)
            }
            aria-label={t("desktopworkspacesection.chatHotkey.enableLabel", {
              defaultValue: "Enable chat summon hotkey",
            })}
          />
        }
      />
      <SettingsRow
        label={t("desktopworkspacesection.chatHotkey.shortcutLabel", {
          defaultValue: "Shortcut",
        })}
        description={
          recording
            ? t("desktopworkspacesection.chatHotkey.recording", {
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
                ? t("desktopworkspacesection.chatHotkey.listening", {
                    defaultValue: "Listening…",
                  })
                : t("desktopworkspacesection.chatHotkey.record", {
                    defaultValue: "Record",
                  })}
            </Button>
            {hotkey.accelerator !== DEFAULT_CHAT_OVERLAY_ACCELERATOR && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  void apply(DEFAULT_CHAT_OVERLAY_ACCELERATOR, hotkey.enabled)
                }
              >
                {t("desktopworkspacesection.chatHotkey.reset", {
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
