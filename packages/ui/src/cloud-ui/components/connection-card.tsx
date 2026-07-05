/**
 * Connection card layout component for platform integration settings.
 * Provides a consistent shell for Discord, Telegram, Twitter, etc. connection UIs.
 */
"use client";

import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  Copy,
  Loader2,
  XCircle,
} from "lucide-react";
import type * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible";
import { Label } from "../../components/ui/label";
import { cn } from "../lib/utils";

type ConnectionCardStatus =
  | "loading"
  | "not-configured"
  | "connected"
  | "disconnected"
  // The status probe FAILED (transport / 5xx / parse / auth). Distinct from
  // "disconnected" (a healthy "not connected yet") so a broken/unreachable
  // backend never renders as the setup form (#12784/#13419 three-state).
  | "error";

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
  status: ConnectionCardStatus;
  /** Content shown when connected */
  connectedContent?: React.ReactNode;
  /** Content shown when disconnected (setup form) */
  setupContent?: React.ReactNode;
  /** Content shown when not configured */
  notConfiguredMessage?: string;
  /** Message shown when the status probe failed (status === "error"). */
  errorMessage?: string;
  /** Optional retry affordance rendered in the error state. */
  onRetry?: () => void;
  /** Label for the retry button in the error state. */
  retryLabel?: string;
  /** Status badge shown in the header when connected */
  statusBadge?: React.ReactNode;
  /** Additional CSS classes */
  className?: string;
}

function ConnectionLoadingCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-sm border bg-card text-card-foreground",
        className,
      )}
    >
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    </div>
  );
}

function ConnectionConnectedBadge({
  label = "Connected",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <Badge variant="default" className={cn("bg-green-500", className)}>
      <CheckCircle className="h-3 w-3 mr-1" />
      {label}
    </Badge>
  );
}

interface ConnectionIdentityPanelProps {
  icon: React.ReactNode;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
  iconClassName?: string;
  className?: string;
  actions?: React.ReactNode;
}

function ConnectionIdentityPanel({
  icon,
  title,
  subtitle,
  children,
  iconClassName,
  className,
  actions,
}: ConnectionIdentityPanelProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-4 p-4 bg-muted rounded-sm",
        className,
      )}
    >
      <div
        className={cn(
          "h-12 w-12 rounded-full flex items-center justify-center shrink-0",
          iconClassName,
        )}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        {title && <div className="font-semibold truncate">{title}</div>}
        {subtitle && (
          <div className="text-sm text-muted-foreground">{subtitle}</div>
        )}
        {children}
      </div>
      {actions}
    </div>
  );
}

interface ConnectionCalloutProps {
  title?: React.ReactNode;
  items?: React.ReactNode[];
  children?: React.ReactNode;
  tone?: "blue" | "green" | "red" | "yellow" | "muted";
  className?: string;
}

const calloutToneClassName: Record<
  NonNullable<ConnectionCalloutProps["tone"]>,
  string
> = {
  // Brand rule: blue is banned. Existing `tone="blue"` call sites now
  // render as a neutral informational callout instead.
  blue: "bg-white/5 border-white/15 text-foreground dark:text-white/80",
  green:
    "bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-400",
  red: "bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-400",
  yellow:
    "bg-yellow-500/10 border-yellow-500/30 text-yellow-700 dark:text-yellow-400",
  muted: "bg-muted border-transparent text-foreground",
};

function ConnectionCallout({
  title,
  items,
  children,
  tone = "muted",
  className,
}: ConnectionCalloutProps) {
  return (
    <div
      className={cn(
        "p-3 border rounded-sm",
        calloutToneClassName[tone],
        className,
      )}
    >
      {title && <p className="text-sm font-medium mb-2">{title}</p>}
      {items && items.length > 0 && (
        <ul className="text-xs text-muted-foreground space-y-1">
          {items.map((item) => (
            <li key={String(item)}>• {item}</li>
          ))}
        </ul>
      )}
      {children}
    </div>
  );
}

interface ConnectionInstructionsProps {
  title: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  triggerClassName?: string;
  contentClassName?: string;
}

function ConnectionInstructions({
  title,
  open,
  onOpenChange,
  children,
  triggerClassName,
  contentClassName,
}: ConnectionInstructionsProps) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            "w-full justify-between p-4 h-auto bg-muted",
            triggerClassName,
          )}
        >
          <span className="font-medium">{title}</span>
          <ChevronDown
            className={cn("h-4 w-4 transition-transform", open && "rotate-180")}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn("p-4 bg-muted rounded-b-lg border-t", contentClassName)}
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

interface ConnectionCopyRowProps {
  label: React.ReactNode;
  value: string;
  onCopied?: (value: string) => void;
  copyLabel?: string;
  className?: string;
}

function ConnectionCopyRow({
  label,
  value,
  onCopied,
  copyLabel = "Copy",
  className,
}: ConnectionCopyRowProps) {
  return (
    <div className={cn("p-3 bg-muted rounded-sm space-y-2", className)}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs bg-background p-2 rounded-sm border overflow-x-auto">
          {value}
        </code>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(value);
            onCopied?.(value);
          }}
        >
          <Copy className="h-4 w-4 mr-1" />
          {copyLabel}
        </Button>
      </div>
    </div>
  );
}

interface ConnectionDisconnectActionProps {
  title: React.ReactNode;
  description: React.ReactNode;
  onDisconnect: () => void;
  isDisconnecting?: boolean;
  buttonLabel?: string;
  confirmLabel?: string;
  triggerIcon?: React.ReactNode;
}

function ConnectionDisconnectAction({
  title,
  description,
  onDisconnect,
  isDisconnecting = false,
  buttonLabel = "Disconnect",
  confirmLabel = "Disconnect",
  triggerIcon,
}: ConnectionDisconnectActionProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="text-red-600 hover:text-red-700"
          disabled={isDisconnecting}
        >
          {isDisconnecting ? (
            <Loader2 className="h-4 w-4 animate-spin mr-1" />
          ) : (
            (triggerIcon ?? <XCircle className="h-4 w-4 mr-1" />)
          )}
          {buttonLabel}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onDisconnect}
            className="bg-red-600 hover:bg-red-700"
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ConnectionFooterActions({
  note,
  children,
  className,
}: {
  note?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between pt-2 border-t",
        className,
      )}
    >
      {note && <div className="text-sm text-muted-foreground">{note}</div>}
      {children}
    </div>
  );
}

function ConnectionCard({
  name,
  icon,
  description,
  status,
  connectedContent,
  setupContent,
  notConfiguredMessage = "This integration is not configured. Please contact your administrator.",
  errorMessage = "We couldn't load this connection's status. Please try again.",
  onRetry,
  retryLabel = "Retry",
  statusBadge,
  className,
}: ConnectionCardProps) {
  if (status === "loading") {
    return <ConnectionLoadingCard className={className} />;
  }

  return (
    <div
      data-slot="connection-card"
      className={cn(
        "min-w-0 overflow-hidden rounded-sm border bg-card text-card-foreground",
        className,
      )}
    >
      {/* Header */}
      <div className="flex min-w-0 flex-col space-y-1.5 p-4 sm:p-6">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="flex min-w-0 items-center gap-2 text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
              <span className="shrink-0 [&>svg]:h-5 [&>svg]:w-5">{icon}</span>
              <span className="min-w-0 break-words">{name}</span>
            </h3>
            <p className="mt-1.5 break-words text-sm text-muted-foreground">
              {status === "not-configured"
                ? `${name} integration is not configured`
                : status === "error"
                  ? `Couldn't load ${name} status`
                  : description}
            </p>
          </div>
          {status === "connected" && statusBadge ? (
            <div className="shrink-0 self-start">{statusBadge}</div>
          ) : null}
        </div>
      </div>

      {/* Content */}
      <div className="min-w-0 p-4 pt-0 sm:p-6 sm:pt-0">
        {status === "not-configured" && (
          <div className="p-4 bg-muted rounded-sm">
            <p className="text-sm text-muted-foreground">
              {notConfiguredMessage}
            </p>
          </div>
        )}
        {status === "error" && (
          <div
            role="alert"
            className="flex flex-col gap-3 p-4 bg-destructive/10 border border-destructive/30 rounded-sm"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
              <p className="text-sm text-destructive">{errorMessage}</p>
            </div>
            {onRetry && (
              <div>
                <Button variant="outline" size="sm" onClick={onRetry}>
                  {retryLabel}
                </Button>
              </div>
            )}
          </div>
        )}
        {status === "connected" && connectedContent}
        {status === "disconnected" && setupContent}
      </div>
    </div>
  );
}

export type { ConnectionCardProps, ConnectionCardStatus };
export {
  ConnectionCallout,
  ConnectionCard,
  ConnectionConnectedBadge,
  ConnectionCopyRow,
  ConnectionDisconnectAction,
  ConnectionFooterActions,
  ConnectionIdentityPanel,
  ConnectionInstructions,
  ConnectionLoadingCard,
};
