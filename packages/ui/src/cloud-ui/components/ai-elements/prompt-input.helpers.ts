/**
 * Non-component pieces of the prompt-input surface: the controller/attachments
 * contexts and the hooks that read them. Kept out of prompt-input.tsx so that
 * file can export only React components (+ types) and stay React Fast
 * Refresh-compatible.
 */

"use client";

import type { FileUIPart } from "ai";
import {
  createContext,
  type PropsWithChildren,
  type RefObject,
  useContext,
} from "react";

export type AttachmentsContext = {
  files: (FileUIPart & { id: string })[];
  add: (files: File[] | FileList) => void;
  remove: (id: string) => void;
  clear: () => void;
  openFileDialog: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
};

export type TextInputContext = {
  value: string;
  setInput: (v: string) => void;
  clear: () => void;
};

export type PromptInputController = {
  textInput: TextInputContext;
  attachments: AttachmentsContext;
  /** INTERNAL: Allows PromptInput to register its file textInput + "open" callback */
  __registerFileInput: (
    ref: RefObject<HTMLInputElement | null>,
    open: () => void,
  ) => void;
};

export type PromptInputProviderBridge = {
  attachments: AttachmentsContext;
  getTextInputValue: () => string;
  clearTextInput: () => void;
  __registerFileInput: PromptInputController["__registerFileInput"];
};

export type PromptInputProviderProps = PropsWithChildren<{
  initialInput?: string;
}>;

export const PromptInputContext = createContext<PromptInputController | null>(
  null,
);
export const ProviderAttachmentsContext =
  createContext<AttachmentsContext | null>(null);
export const PromptInputProviderBridgeContext =
  createContext<PromptInputProviderBridge | null>(null);
export const LocalAttachmentsContext = createContext<AttachmentsContext | null>(
  null,
);

export const usePromptInputController = () => {
  const ctx = useContext(PromptInputContext);
  if (!ctx) {
    throw new Error(
      "Wrap your component inside <PromptInputProvider> to use usePromptInputController().",
    );
  }
  return ctx;
};

// Optional variants (do NOT throw). Useful for dual-mode components.
export const useOptionalPromptInputController = () => {
  return useContext(PromptInputContext);
};

export const useOptionalPromptInputProviderBridge = () => {
  return useContext(PromptInputProviderBridgeContext);
};

export const useProviderAttachments = () => {
  const ctx = useContext(ProviderAttachmentsContext);
  if (!ctx) {
    throw new Error(
      "Wrap your component inside <PromptInputProvider> to use useProviderAttachments().",
    );
  }
  return ctx;
};

export const useOptionalProviderAttachments = () => {
  return useContext(ProviderAttachmentsContext);
};

export const usePromptInputAttachments = () => {
  // Components rendered inside PromptInput get the local/proxy context so
  // per-input constraints apply even when a global provider owns the state.
  const provider = useOptionalProviderAttachments();
  const local = useContext(LocalAttachmentsContext);
  const context = local ?? provider;
  if (!context) {
    throw new Error(
      "usePromptInputAttachments must be used within a PromptInput or PromptInputProvider",
    );
  }
  return context;
};
