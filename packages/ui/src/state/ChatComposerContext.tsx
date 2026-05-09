/**
 * ChatComposerContext — isolated context for chat input state.
 *
 * chatInput, chatSending, and chatPendingImages change on every
 * keystroke / send cycle. Keeping them in AppContext would cascade
 * re-renders to every useApp() subscriber (CompanionViewOverlay,
 * sidebar panels, settings, etc.). This context lets only the
 * composer and its direct consumers re-render.
 */

import {
  createContext,
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useContext,
} from "react";
import type { ImageAttachment } from "../api";

export interface ChatComposerValue {
  chatInput: string;
  chatSending: boolean;
  chatPendingImages: ImageAttachment[];
  setChatInput: (v: string) => void;
  setChatPendingImages: Dispatch<SetStateAction<ImageAttachment[]>>;
}

const DEFAULT_COMPOSER: ChatComposerValue = {
  chatInput: "",
  chatSending: false,
  chatPendingImages: [],
  setChatInput: () => {},
  setChatPendingImages: () => {},
};

export const ChatComposerCtx =
  createContext<ChatComposerValue>(DEFAULT_COMPOSER);

/**
 * Stable ref to the current draft text (mirrors chat input state) so helpers
 * like useContextMenu can append quoted text without subscribing to every
 * keystroke re-render.
 */
export const ChatInputRefCtx = createContext<RefObject<string> | null>(null);

export function useChatComposer(): ChatComposerValue {
  return useContext(ChatComposerCtx);
}

export function useChatInputRef(): RefObject<string> | null {
  return useContext(ChatInputRefCtx);
}
