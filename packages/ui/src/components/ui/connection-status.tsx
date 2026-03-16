import * as React from "react";
import { cn } from "../../lib/utils";

export type ConnectionState = "connected" | "disconnected" | "error";

const STATE_STYLES: Record<
  ConnectionState,
  { dot: string; text: string; label: string }
> = {
  connected: {
    dot: "bg-ok",
    text: "text-txt",
    label: "Connected",
  },
  disconnected: {
    dot: "bg-muted",
    text: "text-muted",
    label: "Disconnected",
  },
  error: {
    dot: "bg-destructive",
    text: "text-destructive",
    label: "Error",
  },
};

export interface ConnectionStatusProps
  extends React.HTMLAttributes<HTMLDivElement> {
  state: ConnectionState;
  /** Custom label — overrides the default state label */
  label?: string;
}

export const ConnectionStatus = React.forwardRef<
  HTMLDivElement,
  ConnectionStatusProps
>(({ state, label, className, ...props }, ref) => {
  const styles = STATE_STYLES[state];
  return (
    <div
      ref={ref}
      className={cn(
        "inline-flex items-center gap-2 rounded-md border border-border bg-bg-accent px-3 py-1.5 text-xs",
        styles.text,
        className,
      )}
      {...props}
    >
      <span className={cn("h-2 w-2 rounded-full", styles.dot)} />
      {label ?? styles.label}
    </div>
  );
});
ConnectionStatus.displayName = "ConnectionStatus";
