/**
 * Context component displaying token usage and cost information.
 * Shows used/max tokens, cost estimates, and provides hover card with details.
 *
 * @param props.usedTokens - Number of tokens used
 * @param props.maxTokens - Maximum tokens allowed
 * @param props.usage - Language model usage data
 * @param props.modelId - Model identifier for cost calculation
 */
import type { LanguageModelUsage } from "ai";
import { type ComponentProps } from "react";
import { type ModelId } from "tokenlens";
import { Button } from "../button";
import { HoverCard, HoverCardContent } from "../hover-card";

type ContextSchema = {
  usedTokens: number;
  maxTokens: number;
  usage?: LanguageModelUsage;
  modelId?: ModelId;
};
export type ContextProps = ComponentProps<typeof HoverCard> & ContextSchema;
export declare const Context: ({
  usedTokens,
  maxTokens,
  usage,
  modelId,
  ...props
}: ContextProps) => import("react/jsx-runtime").JSX.Element;
export type ContextTriggerProps = ComponentProps<typeof Button>;
export declare const ContextTrigger: ({
  children,
  ...props
}: ContextTriggerProps) => import("react/jsx-runtime").JSX.Element;
export type ContextContentProps = ComponentProps<typeof HoverCardContent>;
export declare const ContextContent: ({
  className,
  ...props
}: ContextContentProps) => import("react/jsx-runtime").JSX.Element;
export type ContextContentHeader = ComponentProps<"div">;
export declare const ContextContentHeader: ({
  children,
  className,
  ...props
}: ContextContentHeader) => import("react/jsx-runtime").JSX.Element;
export type ContextContentBody = ComponentProps<"div">;
export declare const ContextContentBody: ({
  children,
  className,
  ...props
}: ContextContentBody) => import("react/jsx-runtime").JSX.Element;
export type ContextContentFooter = ComponentProps<"div">;
export declare const ContextContentFooter: ({
  children,
  className,
  ...props
}: ContextContentFooter) => import("react/jsx-runtime").JSX.Element;
export type ContextInputUsageProps = ComponentProps<"div">;
export declare const ContextInputUsage: ({
  className,
  children,
  ...props
}: ContextInputUsageProps) =>
  | string
  | number
  | bigint
  | true
  | import("react/jsx-runtime").JSX.Element
  | Iterable<import("react").ReactNode>
  | Promise<
      | string
      | number
      | bigint
      | boolean
      | import("react").ReactPortal
      | import("react").ReactElement<
          unknown,
          string | import("react").JSXElementConstructor<any>
        >
      | Iterable<import("react").ReactNode>
      | null
      | undefined
    >
  | null;
export type ContextOutputUsageProps = ComponentProps<"div">;
export declare const ContextOutputUsage: ({
  className,
  children,
  ...props
}: ContextOutputUsageProps) =>
  | string
  | number
  | bigint
  | true
  | import("react/jsx-runtime").JSX.Element
  | Iterable<import("react").ReactNode>
  | Promise<
      | string
      | number
      | bigint
      | boolean
      | import("react").ReactPortal
      | import("react").ReactElement<
          unknown,
          string | import("react").JSXElementConstructor<any>
        >
      | Iterable<import("react").ReactNode>
      | null
      | undefined
    >
  | null;
export type ContextReasoningUsageProps = ComponentProps<"div">;
export declare const ContextReasoningUsage: ({
  className,
  children,
  ...props
}: ContextReasoningUsageProps) =>
  | string
  | number
  | bigint
  | true
  | import("react/jsx-runtime").JSX.Element
  | Iterable<import("react").ReactNode>
  | Promise<
      | string
      | number
      | bigint
      | boolean
      | import("react").ReactPortal
      | import("react").ReactElement<
          unknown,
          string | import("react").JSXElementConstructor<any>
        >
      | Iterable<import("react").ReactNode>
      | null
      | undefined
    >
  | null;
export type ContextCacheUsageProps = ComponentProps<"div">;
export declare const ContextCacheUsage: ({
  className,
  children,
  ...props
}: ContextCacheUsageProps) =>
  | string
  | number
  | bigint
  | true
  | import("react/jsx-runtime").JSX.Element
  | Iterable<import("react").ReactNode>
  | Promise<
      | string
      | number
      | bigint
      | boolean
      | import("react").ReactPortal
      | import("react").ReactElement<
          unknown,
          string | import("react").JSXElementConstructor<any>
        >
      | Iterable<import("react").ReactNode>
      | null
      | undefined
    >
  | null;
//# sourceMappingURL=context.d.ts.map
