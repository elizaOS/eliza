/**
 * Connection card layout component for platform integration settings.
 * Provides a consistent shell for Discord, Telegram, Twitter, etc. connection UIs.
 */
"use client";

import { Loader2 } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/utils";

type ConnectionStatus = "loading" | "not-configured" | "connected" | "disconnected";

interface ConnectionCardProps {
  /** Integration name (e.g. "Discord Bot") */
  name: string;
  /** Icon element for the integration */
  icon: React.ReactNode;
  /** Brand accent color class (e.g. "text-[#5865F2]") */
  brandColorClass?: string;
  /** Short description of the integration */
  description: string;
  /** Current connection status */
  status: ConnectionStatus;
  /** Content shown when connected */
  connectedContent?: React.ReactNode;
  /** Content shown when disconnected (setup form) */
  setupContent?: React.ReactNode;
  /** Content shown when not configured */
  notConfiguredMessage?: string;
  /** Status badge shown in the header when connected */
  statusBadge?: React.ReactNode;
  /** Additional CSS classes */
  className?: string;
}

function ConnectionCard({
  name,
  icon,
  description,
  status,
  connectedContent,
  setupContent,
  notConfiguredMessage = "This integration is not configured. Please contact your administrator.",
  statusBadge,
  className,
}: ConnectionCardProps) {
  if (status === "loading") {
    return (
      <div className={cn("rounded-lg border bg-card text-card-foreground shadow-sm", className)}>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div
      data-slot="connection-card"
      className={cn("rounded-lg border bg-card text-card-foreground shadow-sm", className)}
    >
      {/* Header */}
      <div className="flex flex-col space-y-1.5 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="flex items-center gap-2 text-2xl font-semibold leading-none tracking-tight">
              <span className="[&>svg]:h-5 [&>svg]:w-5">{icon}</span>
              {name}
            </h3>
            <p className="text-sm text-muted-foreground mt-1.5">
              {status === "not-configured" ? `${name} integration is not configured` : description}
            </p>
          </div>
          {status === "connected" && statusBadge}
        </div>
      </div>

      {/* Content */}
      <div className="p-6 pt-0">
        {status === "not-configured" && (
          <div className="p-4 bg-muted rounded-lg">
            <p className="text-sm text-muted-foreground">{notConfiguredMessage}</p>
          </div>
        )}
        {status === "connected" && connectedContent}
        {status === "disconnected" && setupContent}
      </div>
    </div>
  );
}

export type { ConnectionCardProps, ConnectionStatus };
export { ConnectionCard };
