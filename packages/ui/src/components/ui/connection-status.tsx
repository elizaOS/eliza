import * as React from "react";
import { cn } from "../../lib/utils";

export type ConnectionState = "connected" | "disconnected" | "error";

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
    const overrideLabels: Record<ConnectionState, string | undefined> = {
      connected: connectedLabel,
      disconnected: disconnectedLabel,
      error: errorLabel,
    };
    const defaultLabel =
      state === "connected"
        ? "Connected"
        : state === "disconnected"
          ? "Disconnected"
          : "Error";
    return (
      <div
        ref={ref}
        className={cn(
          "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs",
          state === "connected"
            ? "border-ok/25 bg-ok-subtle/70 text-txt"
            : state === "disconnected"
              ? "border-border/70 bg-bg-accent text-muted-strong"
              : "border-destructive/35 bg-destructive-subtle text-destructive",
          className,
        )}
        role={role ?? (state === "error" ? "alert" : "status")}
        aria-live={ariaLive ?? (state === "error" ? "assertive" : "polite")}
        {...props}
      >
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            state === "connected"
              ? "bg-ok"
              : state === "disconnected"
                ? "bg-muted"
                : "bg-destructive",
          )}
        />
        {label ?? overrideLabels[state] ?? defaultLabel}
      </div>
    );
  },
);
ConnectionStatus.displayName = "ConnectionStatus";
