/**
 * Prompt input component for AI chat interfaces with file attachments and voice input.
 * Supports text input, image attachments, audio recording, and model selection.
 */
import type { ChatStatus, FileUIPart } from "ai";
import {
  type ComponentProps,
  type FormEvent,
  type HTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
  type RefObject,
} from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../dropdown-menu";
import {
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "../input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../select";
export type AttachmentsContext = {
  files: (FileUIPart & {
    id: string;
  })[];
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
export declare const usePromptInputController: () => PromptInputController;
export declare const useProviderAttachments: () => AttachmentsContext;
export type PromptInputProviderProps = PropsWithChildren<{
  initialInput?: string;
}>;
/**
 * Optional global provider that lifts PromptInput state outside of PromptInput.
 * If you don't use it, PromptInput stays fully self-managed.
 */
export declare function PromptInputProvider({
  initialInput: initialTextInput,
  children,
}: PromptInputProviderProps): import("react/jsx-runtime").JSX.Element;
export declare const usePromptInputAttachments: () => AttachmentsContext;
export type PromptInputAttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: FileUIPart & {
    id: string;
  };
  className?: string;
};
export declare function PromptInputAttachment({
  data,
  className,
  ...props
}: PromptInputAttachmentProps): import("react/jsx-runtime").JSX.Element;
export type PromptInputAttachmentsProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> & {
  children: (
    attachment: FileUIPart & {
      id: string;
    },
  ) => ReactNode;
};
export declare function PromptInputAttachments({
  className,
  children,
  ...props
}: PromptInputAttachmentsProps): import("react/jsx-runtime").JSX.Element | null;
export type PromptInputActionAddAttachmentsProps = ComponentProps<
  typeof DropdownMenuItem
> & {
  label?: string;
};
export declare const PromptInputActionAddAttachments: ({
  label,
  ...props
}: PromptInputActionAddAttachmentsProps) => import("react/jsx-runtime").JSX.Element;
export type PromptInputMessage = {
  text?: string;
  files?: FileUIPart[];
};
export type PromptInputProps = Omit<
  HTMLAttributes<HTMLFormElement>,
  "onSubmit"
> & {
  accept?: string;
  multiple?: boolean;
  globalDrop?: boolean;
  /** @deprecated File inputs cannot be programmatically synced; retained only to clear the input after attachments clear. */
  syncHiddenInput?: boolean;
  maxFiles?: number;
  maxFileSize?: number;
  onError?: (err: {
    code: "max_files" | "max_file_size" | "accept";
    message: string;
  }) => void;
  onSubmit: (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>,
  ) => void | Promise<void>;
};
export declare const PromptInput: ({
  className,
  accept,
  multiple,
  globalDrop,
  syncHiddenInput,
  maxFiles,
  maxFileSize,
  onError,
  onSubmit,
  children,
  ...props
}: PromptInputProps) => import("react/jsx-runtime").JSX.Element;
export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;
export declare const PromptInputBody: ({
  className,
  ...props
}: PromptInputBodyProps) => import("react/jsx-runtime").JSX.Element;
export type PromptInputTextareaProps = ComponentProps<
  typeof InputGroupTextarea
>;
export declare const PromptInputTextarea: ({
  onChange,
  className,
  placeholder,
  ...props
}: PromptInputTextareaProps) => import("react/jsx-runtime").JSX.Element;
export type PromptInputToolbarProps = Omit<
  ComponentProps<typeof InputGroupAddon>,
  "align"
>;
export declare const PromptInputToolbar: ({
  className,
  ...props
}: PromptInputToolbarProps) => import("react/jsx-runtime").JSX.Element;
export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;
export declare const PromptInputTools: ({
  className,
  ...props
}: PromptInputToolsProps) => import("react/jsx-runtime").JSX.Element;
export type PromptInputButtonProps = ComponentProps<typeof InputGroupButton>;
export declare const PromptInputButton: ({
  variant,
  className,
  size,
  ...props
}: PromptInputButtonProps) => import("react/jsx-runtime").JSX.Element;
export type PromptInputActionMenuProps = ComponentProps<typeof DropdownMenu>;
export declare const PromptInputActionMenu: (
  props: PromptInputActionMenuProps,
) => import("react/jsx-runtime").JSX.Element;
export type PromptInputActionMenuTriggerProps = PromptInputButtonProps;
export declare const PromptInputActionMenuTrigger: ({
  className,
  children,
  ...props
}: PromptInputActionMenuTriggerProps) => import("react/jsx-runtime").JSX.Element;
export type PromptInputActionMenuContentProps = ComponentProps<
  typeof DropdownMenuContent
>;
export declare const PromptInputActionMenuContent: ({
  className,
  ...props
}: PromptInputActionMenuContentProps) => import("react/jsx-runtime").JSX.Element;
export type PromptInputActionMenuItemProps = ComponentProps<
  typeof DropdownMenuItem
>;
export declare const PromptInputActionMenuItem: ({
  className,
  ...props
}: PromptInputActionMenuItemProps) => import("react/jsx-runtime").JSX.Element;
export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
  status?: ChatStatus;
};
export declare const PromptInputSubmit: ({
  className,
  variant,
  size,
  status,
  children,
  ...props
}: PromptInputSubmitProps) => import("react/jsx-runtime").JSX.Element;
interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onresult:
    | ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void)
    | null;
  onerror:
    | ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void)
    | null;
}
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
}
type SpeechRecognitionResultList = {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
};
type SpeechRecognitionResult = {
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
  isFinal: boolean;
};
type SpeechRecognitionAlternative = {
  transcript: string;
  confidence: number;
};
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}
declare global {
  interface Window {
    SpeechRecognition: {
      new (): SpeechRecognition;
    };
    webkitSpeechRecognition: {
      new (): SpeechRecognition;
    };
  }
}
export type PromptInputSpeechButtonProps = ComponentProps<
  typeof PromptInputButton
> & {
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onTranscriptionChange?: (text: string) => void;
};
export declare const PromptInputSpeechButton: ({
  className,
  textareaRef,
  onTranscriptionChange,
  ...props
}: PromptInputSpeechButtonProps) => import("react/jsx-runtime").JSX.Element;
export type PromptInputModelSelectProps = ComponentProps<typeof Select>;
export declare const PromptInputModelSelect: (
  props: PromptInputModelSelectProps,
) => import("react/jsx-runtime").JSX.Element;
export type PromptInputModelSelectTriggerProps = ComponentProps<
  typeof SelectTrigger
>;
export declare const PromptInputModelSelectTrigger: ({
  className,
  ...props
}: PromptInputModelSelectTriggerProps) => import("react/jsx-runtime").JSX.Element;
export type PromptInputModelSelectContentProps = ComponentProps<
  typeof SelectContent
>;
export declare const PromptInputModelSelectContent: ({
  className,
  ...props
}: PromptInputModelSelectContentProps) => import("react/jsx-runtime").JSX.Element;
export type PromptInputModelSelectItemProps = ComponentProps<typeof SelectItem>;
export declare const PromptInputModelSelectItem: ({
  className,
  ...props
}: PromptInputModelSelectItemProps) => import("react/jsx-runtime").JSX.Element;
export type PromptInputModelSelectValueProps = ComponentProps<
  typeof SelectValue
>;
export declare const PromptInputModelSelectValue: ({
  className,
  ...props
}: PromptInputModelSelectValueProps) => import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=prompt-input.d.ts.map
