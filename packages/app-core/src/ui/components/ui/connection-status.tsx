import * as React from "react";
import { cn } from "../../lib/utils";

export type ConnectionState = "connected" | "disconnected" | "error";

const STATE_STYLES: Record<
  ConnectionState,
  {
    dot: string;
    text: string;
    label: string;
    surface: string;
    liveRole: "status" | "alert";
    liveMode: "polite" | "assertive";
  }
> = {
  connected: {
    dot: "bg-ok",
    text: "text-txt",
    label: "Connected",
    surface: "border-ok/25 bg-ok-subtle/70",
    liveRole: "status",
    liveMode: "polite",
  },
  disconnected: {
    dot: "bg-muted",
    text: "text-muted-strong",
    label: "Disconnected",
    surface: "border-border/70 bg-bg-accent",
    liveRole: "status",
    liveMode: "polite",
  },
  error: {
    dot: "bg-destructive",
    text: "text-destructive",
    label: "Error",
    surface: "border-destructive/35 bg-destructive-subtle",
    liveRole: "alert",
    liveMode: "assertive",
  },
};

export interface ConnectionStatusProps
  extends React.HTMLAttributes<HTMLDivElement> {
  state: ConnectionState;
  /** Custom label — overrides the default state label */
  label?: string;
  /** Override label for "Connected" state */
  connectedLabel?: string;
  /** Override label for "Disconnected" state */
  disconnectedLabel?: string;
  /** Override label for "Error" state */
  errorLabel?: string;
}

export const ConnectionStatus = React.forwardRef<
  HTMLDivElement,
  ConnectionStatusProps
>(
  (
    {
      state,
      label,
      connectedLabel,
      disconnectedLabel,
      errorLabel,
      className,
      role,
      "aria-live": ariaLive,
      ...props
    },
    ref,
  ) => {
    const styles = STATE_STYLES[state];
    const overrideLabels: Record<ConnectionState, string | undefined> = {
      connected: connectedLabel,
      disconnected: disconnectedLabel,
      error: errorLabel,
    };
    return (
      <div
        ref={ref}
        className={cn(
          "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs",
          styles.surface,
          styles.text,
          className,
        )}
        role={role ?? styles.liveRole}
        aria-live={ariaLive ?? styles.liveMode}
        {...props}
      >
        <span className={cn("h-2 w-2 rounded-full", styles.dot)} />
        {label ?? overrideLabels[state] ?? styles.label}
      </div>
    );
  },
);
ConnectionStatus.displayName = "ConnectionStatus";
