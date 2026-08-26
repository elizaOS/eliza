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
import { Alert, AlertDescription } from "../../components/ui/alert";
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
import { Card } from "../../components/ui/card";
import { CodeBlock } from "../../components/ui/code-block";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible";
import { Label } from "../../components/ui/label";
import { Separator } from "../../components/ui/separator";
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
    <Card
      variant="accountCard"
      className={cn("min-w-0 overflow-hidden", className)}
    >
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    </Card>
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
    <Badge variant="outline" tone="success" className={className}>
      <CheckCircle className="size-3 mr-1" />
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
    <Card
      variant="flatPadded"
      className={cn("flex items-center gap-4", className)}
    >
      <Card
        variant="connectorAvatar"
        className={cn(
          "flex size-12 shrink-0 items-center justify-center",
          iconClassName,
        )}
      >
        {icon}
      </Card>
      <div className="flex-1 min-w-0">
        {title && <div className="font-semibold truncate">{title}</div>}
        {subtitle && (
          <div className="text-sm text-muted-foreground">{subtitle}</div>
        )}
        {children}
      </div>
      {actions}
    </Card>
  );
}

interface ConnectionCalloutProps {
  title?: React.ReactNode;
  items?: React.ReactNode[];
  children?: React.ReactNode;
  tone?: "blue" | "green" | "red" | "yellow" | "muted";
  className?: string;
}

const calloutToneVariant: Record<
  NonNullable<ConnectionCalloutProps["tone"]>,
  React.ComponentProps<typeof Alert>["variant"]
> = {
  // Brand rule: blue is banned. Existing `tone="blue"` call sites now
  // render as a neutral informational callout instead.
  blue: "default",
  green: "dashboardSuccess",
  red: "destructive",
  yellow: "dashboardWarning",
  muted: "sidebar",
};

function ConnectionCallout({
  title,
  items,
  children,
  tone = "muted",
  className,
}: ConnectionCalloutProps) {
  return (
    <Alert variant={calloutToneVariant[tone]} className={className}>
      <AlertDescription className="block">
        {title && <p className="mb-2 text-sm font-medium">{title}</p>}
        {items && items.length > 0 && (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {items.map((item) => (
              <li key={String(item)}>• {item}</li>
            ))}
          </ul>
        )}
        {children}
      </AlertDescription>
    </Alert>
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
        <Button variant="sectionToggle" className={triggerClassName}>
          <span className="font-medium">{title}</span>
          <ChevronDown
            className={cn("size-4 transition-transform", open && "rotate-180")}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent asChild>
        <Card
          variant="topDivider"
          padding="comfortable"
          className={contentClassName}
        >
          {children}
        </Card>
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
    <Card variant="flatPadded" className={cn("space-y-2 p-3", className)}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <CodeBlock variant="inline" className="flex-1 overflow-x-auto p-2">
          {value}
        </CodeBlock>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(value);
            onCopied?.(value);
          }}
        >
          <Copy className="size-4 mr-1" />
          {copyLabel}
        </Button>
      </div>
    </Card>
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
        <Button variant="dangerOutline" size="sm" disabled={isDisconnecting}>
          {isDisconnecting ? (
            <Loader2 className="size-4 animate-spin mr-1" />
          ) : (
            (triggerIcon ?? <XCircle className="size-4 mr-1" />)
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
          <AlertDialogAction asChild>
            <Button variant="destructive" onClick={onDisconnect}>
              {confirmLabel}
            </Button>
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
    <>
      <Separator />
      <div className={cn("flex items-center justify-between pt-2", className)}>
        {note && <div className="text-sm text-muted-foreground">{note}</div>}
        {children}
      </div>
    </>
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
    <Card
      variant="accountCard"
      data-slot="connection-card"
      className={cn("min-w-0 overflow-hidden", className)}
    >
      {/* Header */}
      <div className="flex min-w-0 flex-col gap-1.5 p-4 sm:p-6">
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
          <Card variant="flatPadded">
            <p className="text-sm text-muted-foreground">
              {notConfiguredMessage}
            </p>
          </Card>
        )}
        {status === "error" && (
          <Alert variant="destructive" className="flex flex-col gap-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="size-4 mt-0.5 shrink-0 text-destructive" />
              <p className="text-sm text-destructive">{errorMessage}</p>
            </div>
            {onRetry && (
              <div>
                <Button variant="outline" size="sm" onClick={onRetry}>
                  {retryLabel}
                </Button>
              </div>
            )}
          </Alert>
        )}
        {status === "connected" && connectedContent}
        {status === "disconnected" && setupContent}
      </div>
    </Card>
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
