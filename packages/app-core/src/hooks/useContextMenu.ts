/**
 * Listens for native desktop context-menu events
 * and dispatches actions into the app state.
 */

import { useCallback, useEffect, useState } from "react";
import { subscribeDesktopBridgeEvent } from "../bridge";
import {
  appendSavedCustomCommand,
  loadSavedCustomCommands,
  type SavedCustomCommand,
} from "../chat";
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

export function useContextMenu(): ContextMenuState {
  const { setState, chatInput, handleChatSend, setActionNotice } = useApp();

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
      setState("chatInput", quoted + chatInput);
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
  }, [setState, chatInput, handleChatSend]);

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
