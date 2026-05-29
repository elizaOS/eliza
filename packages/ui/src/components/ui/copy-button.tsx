import { Check, Copy } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils";

export interface CopyButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  /** Text to copy to clipboard */
  value: string;
  /** Duration of the "copied" feedback in ms */
  feedbackDuration?: number;
  /** Aria-label for default state */
  copyLabel?: string;
  /** Aria-label for copied state */
  copiedLabel?: string;
}

export const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>(
  (
    {
      value,
      feedbackDuration = 2000,
      copyLabel = "Copy",
      copiedLabel = "Copied",
      className,
      children,
      ...props
    },
    ref,
  ) => {
    const [copied, setCopied] = React.useState(false);

    const handleCopy = React.useCallback(() => {
      // No clipboard API (insecure context / unsupported): nothing copied,
      // so do not show success feedback.
      if (!navigator.clipboard?.writeText) {
        setCopied(false);
        return;
      }
      navigator.clipboard.writeText(value).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), feedbackDuration);
        },
        () => {
          // Write rejected (denied permission): leave the button in its
          // default state rather than showing false success.
          setCopied(false);
        },
      );
    }, [value, feedbackDuration]);

    return (
      <button
        ref={ref}
        type="button"
        onClick={handleCopy}
        className={cn(
          "inline-flex items-center gap-1 rounded-md p-1.5 text-muted transition-colors hover:bg-bg-hover hover:text-txt",
          className,
        )}
        aria-label={copied ? copiedLabel : copyLabel}
        {...props}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-ok" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        {children}
      </button>
    );
  },
);
CopyButton.displayName = "CopyButton";
