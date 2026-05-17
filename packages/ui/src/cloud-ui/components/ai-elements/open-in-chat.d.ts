/**
 * Open in chat component providing dropdown menu to open content in external chat providers.
 * Supports GitHub and Scira providers with URL generation.
 */
import { type ComponentProps } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu";
export type OpenInProps = ComponentProps<typeof DropdownMenu> & {
  query: string;
};
export declare const OpenIn: ({
  query,
  ...props
}: OpenInProps) => import("react/jsx-runtime").JSX.Element;
export type OpenInContentProps = ComponentProps<typeof DropdownMenuContent>;
export declare const OpenInContent: ({
  className,
  ...props
}: OpenInContentProps) => import("react/jsx-runtime").JSX.Element;
export type OpenInItemProps = ComponentProps<typeof DropdownMenuItem>;
export declare const OpenInItem: (
  props: OpenInItemProps,
) => import("react/jsx-runtime").JSX.Element;
export type OpenInLabelProps = ComponentProps<typeof DropdownMenuLabel>;
export declare const OpenInLabel: (
  props: OpenInLabelProps,
) => import("react/jsx-runtime").JSX.Element;
export type OpenInSeparatorProps = ComponentProps<typeof DropdownMenuSeparator>;
export declare const OpenInSeparator: (
  props: OpenInSeparatorProps,
) => import("react/jsx-runtime").JSX.Element;
export type OpenInTriggerProps = ComponentProps<typeof DropdownMenuTrigger>;
export declare const OpenInTrigger: ({
  children,
  ...props
}: OpenInTriggerProps) => import("react/jsx-runtime").JSX.Element;
export type OpenInChatGPTProps = ComponentProps<typeof DropdownMenuItem>;
export declare const OpenInChatGPT: (
  props: OpenInChatGPTProps,
) => import("react/jsx-runtime").JSX.Element;
export type OpenInClaudeProps = ComponentProps<typeof DropdownMenuItem>;
export declare const OpenInClaude: (
  props: OpenInClaudeProps,
) => import("react/jsx-runtime").JSX.Element;
export type OpenInT3Props = ComponentProps<typeof DropdownMenuItem>;
export declare const OpenInT3: (
  props: OpenInT3Props,
) => import("react/jsx-runtime").JSX.Element;
export type OpenInSciraProps = ComponentProps<typeof DropdownMenuItem>;
export declare const OpenInScira: (
  props: OpenInSciraProps,
) => import("react/jsx-runtime").JSX.Element;
export type OpenInv0Props = ComponentProps<typeof DropdownMenuItem>;
export declare const OpenInv0: (
  props: OpenInv0Props,
) => import("react/jsx-runtime").JSX.Element;
export type OpenInCursorProps = ComponentProps<typeof DropdownMenuItem>;
export declare const OpenInCursor: (
  props: OpenInCursorProps,
) => import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=open-in-chat.d.ts.map
