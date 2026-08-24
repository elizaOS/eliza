/**
 * Multi-line text-input primitive with cva variants, mirroring the Input skins
 * so single- and multi-line fields share styling across settings/config forms.
 * Coarse-pointer surfaces use 16px font size to prevent iOS Safari focus-zoom.
 */
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/utils";

const textareaVariants = cva(
  "w-full border text-sm pointer-coarse:text-[16px] resize-y transition-[border-color,box-shadow,background-color] disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "flex rounded-sm border-input bg-bg px-3 py-2  placeholder:text-muted    ",
        form: "rounded-sm border-border bg-bg px-4 py-3    ",
        config:
          "border-border bg-card font-[var(--mono)] placeholder:text-muted placeholder:opacity-60    ",
        codeEditor:
          "resize-none rounded-xl border-0 bg-zinc-950 p-4 font-mono text-zinc-100 placeholder:text-muted",
        document:
          "rounded-sm border-border/55 bg-bg/72 px-3 py-2 text-xs shadow-none placeholder:text-muted",
        documentEditor:
          "resize-y rounded-sm border-border/40 bg-bg-muted/15 px-3 py-2 font-mono text-sm leading-relaxed placeholder:text-muted",
        configDialog:
          "resize-y rounded-sm border-border/60 bg-bg-muted px-3 py-2 font-mono text-sm placeholder:text-muted",
        mobileComposer:
          "resize-none rounded-xl border-border bg-card px-3 py-2 placeholder:text-muted",
        modal:
          "rounded-sm border-border bg-bg-hover px-4 py-3 text-sm text-txt placeholder:text-muted",
        settings:
          "rounded-sm border-border/60 bg-bg/55 px-3 py-2 font-mono text-xs-tight",
      },
      density: {
        default: "min-h-[80px]",
        compact: "min-h-[64px] px-2 py-1.5 text-xs",
        relaxed: "min-h-[132px]",
        editor: "min-h-[420px] text-xs leading-5",
        document: "min-h-28",
        tall: "min-h-[20rem]",
        dialogEditor: "min-h-40",
        singleLine: "min-h-11",
        modalDefault: "min-h-[88px]",
        modalShort: "min-h-[72px]",
        modalLogs: "min-h-[120px] font-mono text-xs",
        configRegular: "min-h-[72px] max-h-[400px] px-3 py-2 text-sm",
      },
    },
    defaultVariants: {
      variant: "default",
      density: "default",
    },
  },
);

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    VariantProps<typeof textareaVariants> {
  hasError?: boolean;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, variant, density, hasError, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          textareaVariants({ variant, density }),
          hasError &&
            "border-destructive bg-[color-mix(in_srgb,var(--destructive)_3%,var(--card))]",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea, textareaVariants };
