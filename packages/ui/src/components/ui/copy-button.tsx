/**
 * Button that copies a string to the clipboard and briefly swaps its icon to a
 * checkmark as copied-confirmation feedback (`feedbackDuration` ms).
 */
import { Check, Copy } from "lucide-react";
import * as React from "react";
import { Button } from "./button";

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
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(
      () => () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
      },
      [],
    );

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
          if (timerRef.current) {
            clearTimeout(timerRef.current);
          }
          timerRef.current = setTimeout(
            () => setCopied(false),
            feedbackDuration,
          );
        },
        () => {
          // Write rejected (denied permission): leave the button in its
          // default state rather than showing false success.
          setCopied(false);
        },
      );
    }, [value, feedbackDuration]);

    return (
      <Button
        ref={ref}
        type="button"
        variant="ghostMuted"
        size="inlineIcon"
        onClick={handleCopy}
        className={className}
        aria-label={copied ? copiedLabel : copyLabel}
        {...props}
      >
        {copied ? (
          <Check className="size-3.5 text-ok" />
        ) : (
          <Copy className="size-3.5" />
        )}
        {children}
      </Button>
    );
  },
);
CopyButton.displayName = "CopyButton";
