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
      wrap = false,
      copyable = false,
      className,
      ...props
    },
    ref,
  ) {
    const content = children ?? value ?? "";
    const copyValue = copyable ? resolveCopyValue(value, children) : null;

    if (variant === "inline") {
      return (
        <code
          ref={ref as React.Ref<HTMLElement>}
          className={cn(baseClassName, "px-1.5 py-0.5", className)}
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
            className,
          )}
          {...(props as React.HTMLAttributes<HTMLPreElement>)}
        >
          {content}
        </pre>
        {copyValue !== null ? (
          <CopyButton
            value={copyValue}
            className="absolute right-1.5 top-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
          />
        ) : null}
      </div>
    );
  },
);
CodeBlock.displayName = "CodeBlock";
