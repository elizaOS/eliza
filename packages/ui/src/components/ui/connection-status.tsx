/**
 * Status dot + label for a live connection (connected/disconnected/error),
 * with per-state label overrides. This is the composite component named
 * `ConnectionStatus`; the identically named cloud-ui string union is
 * deliberately not re-exported from the root barrel to avoid the collision
 * (see the note in src/index.ts).
 */
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
    const overrideLabel =
      state === "connected"
        ? connectedLabel
        : state === "disconnected"
          ? disconnectedLabel
          : errorLabel;
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
          "inline-flex items-center gap-2 rounded-sm border px-3 py-1.5 text-xs",
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
        {label ?? overrideLabel ?? defaultLabel}
      </div>
    );
  },
);
ConnectionStatus.displayName = "ConnectionStatus";
