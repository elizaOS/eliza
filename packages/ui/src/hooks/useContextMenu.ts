/**
 * Listens for native desktop context-menu events
 * and dispatches actions into the app state.
 */

import { useEffect } from "react";
import {
  invokeDesktopBridgeRequest,
  isElectrobunRuntime,
  subscribeDesktopBridgeEvent,
} from "../bridge";
import { dispatchChatPrefill } from "../events";
import { useAppSelectorShallow } from "../state/app-store";

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

/**
 * Editable native targets (text inputs, textareas, contenteditable) own the
 * platform's Cut/Copy/Paste context menu. Suppressing it there would strip the
 * user's clipboard editing, so the custom selection menu only takes over
 * non-editable surfaces (message text, links).
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return true;
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

export function useContextMenu(): void {
  const { setState, handleChatSend } = useAppSelectorShallow(
    (s) => ({
      setState: s.setState,
      handleChatSend: s.handleChatSend,
    }),
  );
  const desktopRuntime = isElectrobunRuntime();

  useEffect(() => {
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
      // Route through the same prefill channel the live floating composer
      // (ChatOverlay) consumes. Writing to the app-store `chatInput`
      // slice would land in the detached-window ChatView, which is not mounted
      // on the surface where the context menu fires — so the quote vanished.
      dispatchChatPrefill({ text: quoted, select: false });
    };

    const unsubscribers = [
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
  }, [setState, handleChatSend]);

  useEffect(() => {
    if (!desktopRuntime || typeof window === "undefined") {
      return;
    }

    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      // Never shadow the native Cut/Copy/Paste menu on editable fields.
      if (isEditableTarget(event.target)) {
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
}
