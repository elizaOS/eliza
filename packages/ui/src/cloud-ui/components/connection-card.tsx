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
  RefreshCw,
  XCircle,
} from "lucide-react";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  SettingsGroup,
  SettingsRow,
} from "../../components/settings/settings-layout";
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
import { Skeleton } from "../../components/ui/skeleton";
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
  icon: ReactNode;
  /** Brand accent color class (e.g. "text-[#5865F2]") */
  brandColorClass?: string;
  /** Short description of the integration */
  description: string;
  /** Current connection status */
  status: ConnectionCardStatus;
  /** Content shown when connected */
  connectedContent?: ReactNode;
  /** Content shown when disconnected (setup form) */
  setupContent?: ReactNode;
  /** Content shown when not configured */
  notConfiguredMessage?: string;
  /**
   * Diagnostic returned by the provider when its status probe fails.
   * ConnectionCard deliberately does not repeat this message in every row;
   * ConnectionStatusNotice owns the single section-level recovery state.
   */
  errorMessage?: string;
  /** Optional retry included in the section-level recovery action. */
  onRetry?: () => void;
  /** @deprecated Recovery copy is standardized by ConnectionStatusNotice. */
  retryLabel?: string;
  /** Status badge shown in the header when connected */
  statusBadge?: ReactNode;
  /** Additional CSS classes */
  className?: string;
}

function ConnectionLoadingCard({ className }: { className?: string }) {
  return (
    <Card
      variant="accountCard"
      className={cn("settings-surface min-w-0 overflow-hidden", className)}
      role="status"
      aria-label="Checking connection status"
    >
      <SettingsRow
        label={<Skeleton className="h-4 w-32 max-w-full" />}
        description={<Skeleton className="mt-1 h-3 w-20 max-w-full" />}
      />
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
  icon: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  iconClassName?: string;
  className?: string;
  actions?: ReactNode;
}

interface UnavailableConnection {
  name: string;
  retry?: () => void;
}

type ConnectionStatusReporter = (
  id: string,
  connection: UnavailableConnection | null,
) => void;

const ConnectionStatusReportContext =
  createContext<ConnectionStatusReporter | null>(null);
const UnavailableConnectionsContext = createContext<
  readonly UnavailableConnection[]
>([]);

/**
 * Collects provider-level probe failures without coupling each connector to
 * section layout. A section can then render one quiet recovery row instead of
 * repeating a destructive alert inside every connector.
 */
function ConnectionStatusProvider({ children }: { children: ReactNode }) {
  const [unavailable, setUnavailable] = useState<
    Map<string, UnavailableConnection>
  >(() => new Map());

  const report = useCallback<ConnectionStatusReporter>((id, connection) => {
    setUnavailable((current) => {
      if (connection === null) {
        if (!current.has(id)) return current;
        const next = new Map(current);
        next.delete(id);
        return next;
      }

      const previous = current.get(id);
      if (
        previous?.name === connection.name &&
        previous.retry === connection.retry
      ) {
        return current;
      }
      const next = new Map(current);
      next.set(id, connection);
      return next;
    });
  }, []);

  const entries = useMemo(() => [...unavailable.values()], [unavailable]);

  return (
    <ConnectionStatusReportContext.Provider value={report}>
      <UnavailableConnectionsContext.Provider value={entries}>
        {children}
      </UnavailableConnectionsContext.Provider>
    </ConnectionStatusReportContext.Provider>
  );
}

/** One compact, section-owned degraded-state signal for all failed probes. */
function ConnectionStatusNotice() {
  const unavailable = useContext(UnavailableConnectionsContext);
  const retryable = useMemo(
    () => unavailable.filter((connection) => connection.retry),
    [unavailable],
  );
  const retryAll = useCallback(() => {
    for (const connection of retryable) connection.retry?.();
  }, [retryable]);

  if (unavailable.length === 0) return null;

  return (
    <SettingsGroup
      data-slot="connection-status-notice"
      aria-live="polite"
      aria-atomic="true"
    >
      <SettingsRow
        icon={AlertTriangle}
        label="Status checks unavailable"
        description="Setup is hidden until checks recover."
        control={
          retryable.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Retry unavailable connections"
              onClick={retryAll}
            >
              <RefreshCw className="size-4" aria-hidden />
              Retry
            </Button>
          ) : null
        }
      />
    </SettingsGroup>
  );
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
      surface="raised"
      radius="large"
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
  title?: ReactNode;
  items?: ReactNode[];
  children?: ReactNode;
  tone?: "blue" | "green" | "red" | "yellow" | "muted";
  className?: string;
}

const calloutToneVariant: Record<
  NonNullable<ConnectionCalloutProps["tone"]>,
  ComponentProps<typeof Alert>["variant"]
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
  title: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
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
          variant="insetPadded"
          padding="comfortable"
          radius="large"
          className={contentClassName}
        >
          {children}
        </Card>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface ConnectionCopyRowProps {
  label: ReactNode;
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
    <Card
      variant="insetPadded"
      radius="large"
      className={cn("space-y-2", className)}
    >
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
  title: ReactNode;
  description: ReactNode;
  onDisconnect: () => void;
  isDisconnecting?: boolean;
  buttonLabel?: string;
  confirmLabel?: string;
  triggerIcon?: ReactNode;
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
  note?: ReactNode;
  children: ReactNode;
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
  onRetry,
  statusBadge,
  className,
}: ConnectionCardProps) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const reportStatus = useContext(ConnectionStatusReportContext);
  const retryRef = useRef(onRetry);
  retryRef.current = onRetry;
  const retryConnection = useCallback(() => retryRef.current?.(), []);
  const canRetry = Boolean(onRetry);

  useEffect(() => {
    if (status === "loading" || status === "error") setOpen(false);
  }, [status]);

  useEffect(() => {
    if (!reportStatus) return;
    reportStatus(
      contentId,
      status === "error"
        ? {
            name,
            retry: canRetry ? retryConnection : undefined,
          }
        : null,
    );
    return () => reportStatus(contentId, null);
  }, [canRetry, contentId, name, reportStatus, retryConnection, status]);

  const statusLabel =
    status === "loading"
      ? "Checking connection"
      : status === "connected"
        ? "Connected"
        : status === "disconnected"
          ? "Not connected"
          : "Unavailable";
  const actionLabel = open
    ? "Close"
    : status === "connected"
      ? "Manage"
      : status === "disconnected"
        ? "Set up"
        : "Details";

  return (
    <SettingsRow
      className={cn("settings-surface", className)}
      label={
        <span className="flex min-w-0 items-center gap-3">
          <Card
            asChild
            variant="sidebarIcon"
            radius="large"
            className="flex size-8 shrink-0 items-center justify-center [&>svg]:size-[18px]"
          >
            <span>{icon}</span>
          </Card>
          <span className="min-w-0 truncate">{name}</span>
        </span>
      }
      description={
        status === "loading" ? (
          <span className="flex items-center gap-2" aria-live="polite">
            <Skeleton className="h-3 w-20" />
            <span className="sr-only">{statusLabel}</span>
          </span>
        ) : (
          <span aria-live="polite">{statusLabel}</span>
        )
      }
      control={
        status === "loading" ? (
          <Skeleton className="h-8 w-20" />
        ) : status === "error" ? null : (
          <span className="flex items-center gap-2">
            {status === "connected" && statusBadge ? (
              <span className="hidden sm:inline-flex">{statusBadge}</span>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={open}
              aria-controls={contentId}
              aria-label={`${actionLabel} ${name}`}
              onClick={() => setOpen((current) => !current)}
            >
              {actionLabel}
              <ChevronDown
                className={cn(
                  "size-4 transition-transform",
                  open && "rotate-180",
                )}
                aria-hidden
              />
            </Button>
          </span>
        )
      }
    >
      {open && status !== "loading" && status !== "error" ? (
        <Card asChild variant="topDivider">
          <div
            id={contentId}
            data-slot="connection-card-content"
            className="min-w-0 pb-1 pt-4"
          >
            <p className="mb-4 break-words text-sm leading-5 text-[color:var(--settings-muted)]">
              {description}
            </p>
            {status === "not-configured" ? (
              <Card variant="insetPadded" radius="large" className="p-4">
                <p className="text-sm text-[color:var(--settings-muted)]">
                  {notConfiguredMessage}
                </p>
              </Card>
            ) : null}
            {status === "connected" ? connectedContent : null}
            {status === "disconnected" ? setupContent : null}
          </div>
        </Card>
      ) : null}
    </SettingsRow>
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
  ConnectionStatusNotice,
  ConnectionStatusProvider,
};
