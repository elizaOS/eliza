/**
 * Monospace code renderer with an optional inline `CopyButton`. `variant`
 * switches between a block `<pre>` and an inline `<code>` span; `copyable`
 * requires a string value to copy.
 */
import * as React from "react";
import { cn } from "../../lib/utils";
import { CopyButton } from "./copy-button";

export interface CodeBlockProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "children"> {
  /** Text content to render (and copy). */
  value?: string;
  children?: React.ReactNode;
  /** Block (default) renders a <pre>; inline renders a <code> span. */
  variant?: "block" | "inline";
  presentation?: "default" | "attachment" | "compactResult";
  size?: "default" | "prose";
  tone?: "default" | "muted" | "strong" | "destructive";
  /** Wrap long lines instead of scrolling horizontally (block only). */
  wrap?: boolean;
  /** Show a top-right copy button. Requires a string value to copy. */
  copyable?: boolean;
}

const baseClassName =
  "font-mono text-xs leading-6 rounded-sm border border-border/35 bg-bg/35";

function resolveCopyValue(
  value: string | undefined,
  children: React.ReactNode,
): string | null {
  if (typeof value === "string") return value;
  if (typeof children === "string") return children;
  return null;
}

export const CodeBlock = React.forwardRef<HTMLElement, CodeBlockProps>(
  function CodeBlock(
    {
      value,
      children,
      variant = "block",
      presentation = "default",
      size = "default",
      tone = "default",
      wrap = false,
      copyable = false,
      className,
      ...props
    },
    ref,
  ) {
    const content = children ?? value ?? "";
    const copyValue = copyable ? resolveCopyValue(value, children) : null;
    const sizeClassName = size === "prose" ? "text-[0.95em]" : undefined;
    const toneClassName =
      tone === "muted"
        ? "text-muted"
        : tone === "strong"
          ? "text-txt-strong"
          : tone === "destructive"
            ? "text-destructive"
            : undefined;

    if (variant === "inline") {
      return (
        <code
          ref={ref as React.Ref<HTMLElement>}
          className={cn(
            baseClassName,
            "px-1.5 py-0.5",
            sizeClassName,
            toneClassName,
            className,
          )}
          {...props}
        >
          {content}
        </code>
      );
    }

    return (
      <div className="relative">
        <pre
          ref={ref as React.Ref<HTMLPreElement>}
          className={cn(
            baseClassName,
            "m-0 overflow-auto p-3 text-txt",
            wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
            copyValue !== null ? "pr-10" : undefined,
            presentation === "attachment" &&
              "max-h-[24rem] rounded-none border-0 bg-transparent",
            presentation === "compactResult" && "p-2 text-xs-tight",
            sizeClassName,
            toneClassName,
            className,
          )}
          {...(props as React.HTMLAttributes<HTMLPreElement>)}
        >
          {content}
        </pre>
        {copyValue !== null ? (
          <CopyButton
            value={copyValue}
            className="absolute right-1.5 top-1.5   "
          />
        ) : null}
      </div>
    );
  },
);
CodeBlock.displayName = "CodeBlock";
