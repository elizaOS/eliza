/**
 * BrowserLaunchWidget — in-chat lifecycle card for an agent-driven browser
 * session: idle (offer to launch) → launching → awaiting (user action in the
 * browser) → done (with an optional screenshot). Presentational only: the
 * caller owns `status` and wires `onLaunch` / `onCancel`. It reuses the same
 * status-dot + globe vocabulary as {@link BrowserStatusSidebarWidget}.
 */

import { Globe, Loader2 } from "lucide-react";
import { Button } from "../../ui/button";

export type BrowserLaunchStatus = "idle" | "launching" | "awaiting" | "done";

export type BrowserLaunchWidgetProps = {
  status: BrowserLaunchStatus;
  url?: string;
  title?: string;
  screenshotUrl?: string;
  message?: string;
  onLaunch?: () => void;
  onCancel?: () => void;
};

type StatusStyle = {
  label: string;
  dotClass: string;
};

function statusStyle(status: BrowserLaunchStatus): StatusStyle {
  switch (status) {
    case "launching":
      return { label: "Launching", dotClass: "bg-accent" };
    case "awaiting":
      return { label: "Awaiting you", dotClass: "bg-accent" };
    case "done":
      return { label: "Done", dotClass: "bg-muted/50" };
    default:
      return { label: "Ready", dotClass: "bg-muted/50" };
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || url;
  } catch {
    // error-policy:J3 unparseable URL — label with the raw string
    return url;
  }
}

export function BrowserLaunchWidget({
  status,
  url,
  title,
  screenshotUrl,
  message,
  onLaunch,
  onCancel,
}: BrowserLaunchWidgetProps) {
  const style = statusStyle(status);
  const target = title?.trim() || (url ? hostnameOf(url) : undefined);
  const inFlight = status === "launching" || status === "awaiting";

  return (
    <div
      data-testid="browser-launch"
      data-browser-status={status}
      className="my-2 border border-border bg-card p-3 text-sm space-y-3"
    >
      <div className="flex items-center gap-2">
        <Globe className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium">
          {target ?? "Browser session"}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 rounded-full ${style.dotClass}`}
            aria-hidden
          />
          <span
            data-testid="browser-launch-status"
            className="text-3xs uppercase tracking-wider text-muted"
          >
            {style.label}
          </span>
        </span>
      </div>

      {url ? (
        <div className="truncate text-xs text-muted" title={url}>
          {url}
        </div>
      ) : null}

      {message ? <div className="text-xs text-muted">{message}</div> : null}

      {status === "done" && screenshotUrl ? (
        <img
          src={screenshotUrl}
          alt={target ? `Screenshot of ${target}` : "Browser screenshot"}
          data-testid="browser-launch-screenshot"
          className="max-h-48 w-full border border-border object-cover"
        />
      ) : null}

      {status === "idle" ? (
        <Button
          type="button"
          size="sm"
          data-testid="browser-launch-start"
          onClick={() => onLaunch?.()}
        >
          <Globe className="h-3.5 w-3.5" aria-hidden />
          Launch browser
        </Button>
      ) : null}

      {inFlight ? (
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {status === "launching"
              ? "Starting the browser…"
              : "Waiting for you to finish in the browser…"}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="browser-launch-cancel"
            className="h-7 px-3 text-xs"
            onClick={() => onCancel?.()}
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}
