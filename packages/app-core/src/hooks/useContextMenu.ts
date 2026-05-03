/**
 * Listens for native desktop context-menu events
 * and dispatches actions into the app state.
 */

import { useCallback, useEffect, useState } from "react";
import {
  invokeDesktopBridgeRequest,
  isElectrobunRuntime,
  subscribeDesktopBridgeEvent,
} from "../bridge";
import {
  appendSavedCustomCommand,
  loadSavedCustomCommands,
  type SavedCustomCommand,
} from "../chat";
import { useChatInputRef } from "../state/ChatComposerContext";
import { useApp } from "../state/useApp";

export type CustomCommand = SavedCustomCommand;

/** Read saved custom commands from localStorage. */
export function loadCustomCommands(): CustomCommand[] {
  return loadSavedCustomCommands();
}

export interface ContextMenuState {
  saveCommandModalOpen: boolean;
  saveCommandText: string;
  customCommands: CustomCommand[];
  closeSaveCommandModal: () => void;
  confirmSaveCommand: (name: string) => void;
}

function getSelectedText(target: EventTarget | null): string {
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  ) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? start;
    return target.value.slice(start, end).trim();
  }

  if (typeof window.getSelection === "function") {
    return window.getSelection()?.toString().trim() ?? "";
  }

  return "";
}

export function useContextMenu(): ContextMenuState {
  const { setState, handleChatSend, setActionNotice } = useApp();
  // useChatInputRef() returns a stable MutableRefObject — subscribing to it never
  // causes re-renders, so App.tsx (which calls this hook) stays quiet while typing.
  const chatInputRef = useChatInputRef();
  const desktopRuntime = isElectrobunRuntime();

  const [saveCommandModalOpen, setSaveCommandModalOpen] = useState(false);
  const [saveCommandText, setSaveCommandText] = useState("");
  const [customCommands, setCustomCommands] =
    useState<CustomCommand[]>(loadCustomCommands);

  useEffect(() => {
    const onSaveAsCommand = (payload: unknown) => {
      const command = payload as { text: string } | undefined;
      if (!command?.text) return;
      setSaveCommandText(command.text);
      setSaveCommandModalOpen(true);
    };

    const onAskAgent = (payload: unknown) => {
      const command = payload as { text: string } | undefined;
      if (!command?.text) return;
      setState("chatInput", command.text);
      // Defer send to next tick so chatInput state propagates
      setTimeout(() => handleChatSend(), 0);
    };

    const onCreateSkill = (payload: unknown) => {
      const command = payload as { text: string } | undefined;
      if (!command?.text) return;
      const prompt = `Create a skill from the following content:\n\n"""${command.text}"""\n\nAnalyze this and create a reusable skill.`;
      setState("chatInput", prompt);
      setTimeout(() => handleChatSend(), 0);
    };

    const onQuoteInChat = (payload: unknown) => {
      const command = payload as { text: string } | undefined;
      if (!command?.text) return;
      const quoted = `> ${command.text}\n\n`;
      const existing = chatInputRef?.current ?? "";
      setState("chatInput", quoted + existing);
    };

    const unsubscribers = [
      subscribeDesktopBridgeEvent({
        rpcMessage: "contextMenuSaveAsCommand",
        ipcChannel: "contextMenu:saveAsCommand",
        listener: onSaveAsCommand,
      }),
      subscribeDesktopBridgeEvent({
        rpcMessage: "contextMenuAskAgent",
        ipcChannel: "contextMenu:askAgent",
        listener: onAskAgent,
      }),
      subscribeDesktopBridgeEvent({
        rpcMessage: "contextMenuCreateSkill",
        ipcChannel: "contextMenu:createSkill",
        listener: onCreateSkill,
      }),
      subscribeDesktopBridgeEvent({
        rpcMessage: "contextMenuQuoteInChat",
        ipcChannel: "contextMenu:quoteInChat",
        listener: onQuoteInChat,
      }),
    ];

    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, [setState, handleChatSend, chatInputRef]);

  useEffect(() => {
    if (!desktopRuntime || typeof window === "undefined") {
      return;
    }

    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      const text = getSelectedText(event.target);
      if (!text) {
        return;
      }

      event.preventDefault();
      void invokeDesktopBridgeRequest({
        rpcMethod: "desktopShowSelectionContextMenu",
        ipcChannel: "desktop:showSelectionContextMenu",
        params: { text },
      });
    };

    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, [desktopRuntime]);

  const closeSaveCommandModal = useCallback(() => {
    setSaveCommandModalOpen(false);
    setSaveCommandText("");
  }, []);

  const confirmSaveCommand = useCallback(
    (name: string) => {
      const cmd: CustomCommand = {
        name,
        text: saveCommandText,
        createdAt: Date.now(),
      };
      appendSavedCustomCommand(cmd);
      setCustomCommands(loadCustomCommands());
      setSaveCommandModalOpen(false);
      setSaveCommandText("");
      setActionNotice(`Saved /${name} command`, "success");
    },
    [saveCommandText, setActionNotice],
  );

  return {
    saveCommandModalOpen,
    saveCommandText,
    customCommands,
    closeSaveCommandModal,
    confirmSaveCommand,
  };
}
