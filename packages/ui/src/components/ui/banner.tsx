import { cva, type VariantProps } from "class-variance-authority";
import { AlertTriangle, Info, X, XCircle } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

const bannerVariants = cva(
  "flex items-center gap-3 border px-4 py-2.5 text-xs",
  {
    variants: {
      variant: {
        error: "border-destructive/30 bg-destructive/10 text-destructive",
        warning: "border-warn/30 bg-warn/10 text-warn",
        info: "border-accent/30 bg-accent/10 text-accent",
      },
    },
    defaultVariants: {
      variant: "info",
    },
  },
);

const ICONS: Record<string, React.ElementType> = {
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

export interface BannerProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof bannerVariants> {
  /** Optional action element (button, link) */
  action?: React.ReactNode;
  /** Show dismiss button */
  dismissible?: boolean;
  /** Called when dismiss is clicked */
  onDismiss?: () => void;
  /** Aria-label for dismiss button */
  dismissLabel?: string;
}

export const Banner = React.forwardRef<HTMLDivElement, BannerProps>(
  (
    {
      variant = "info",
      action,
      dismissible,
      onDismiss,
      dismissLabel = "Dismiss",
      className,
      children,
      ...props
    },
    ref,
  ) => {
    const Icon = ICONS[variant ?? "info"];

    return (
      <div
        ref={ref}
        className={cn(bannerVariants({ variant }), className)}
        role="alert"
        {...props}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="flex-1">{children}</span>
        {action}
        {dismissible && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onDismiss}
            className="h-6 w-6 rounded-sm opacity-70 hover:opacity-100 transition-opacity"
            aria-label={dismissLabel}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    );
  },
);
Banner.displayName = "Banner";
