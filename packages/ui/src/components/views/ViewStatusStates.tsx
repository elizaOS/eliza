/**
 * Shared view status surfaces — the loading skeleton, the recoverable
 * "Failed to load view" error card, and the platform-restricted card.
 *
 * These were originally private to `DynamicViewLoader`, but EVERY way of
 * dynamically loading a view (the remote-bundle `DynamicViewLoader` AND the
 * `RetainedLazyComponent`-based overlay/app loaders) must surface the SAME
 * recoverable card on failure instead of a blank/white screen. Extracting them
 * here lets each loader reuse the identical UI (issue: harden view load errors)
 * rather than inventing a second error surface.
 */

import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  LoaderCircle,
  RotateCw,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { shellHistory } from "../../surface-realm-channel";
import { Alert } from "../ui/alert.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";

/**
 * Navigate back to the view launcher (`/views`). Hoisted so the error/crash
 * recovery surfaces can offer a "Back to views" escape hatch without depending
 * on the view itself having wired the `exitToApps` prop.
 */
export function navigateToViews() {
  if (typeof window !== "undefined") {
    shellHistory.pushState(null, "", "/views");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

export function ViewStatusFrame({
  tone,
  icon,
  title,
  children,
  actions,
}: {
  tone: "loading" | "error" | "restricted";
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      className="flex flex-1 min-h-0 min-w-0 items-center justify-center p-6"
      data-view-status={tone}
    >
      <Alert
        variant={
          tone === "error"
            ? "destructive"
            : tone === "restricted"
              ? "sidebar"
              : "default"
        }
        role={tone === "error" ? "alert" : "status"}
        className="flex w-full max-w-sm flex-col gap-3 p-4"
      >
        <div className="flex items-center gap-3">
          <Badge
            variant="visualAnchor"
            tone={
              tone === "error"
                ? "danger"
                : tone === "restricted"
                  ? "muted"
                  : "accent"
            }
            className="grid size-10 shrink-0 place-items-center"
          >
            {icon}
          </Badge>
          <div className="min-w-0 text-left">
            <div className="text-sm font-semibold">{title}</div>
            {children ? <div className="mt-1 text-xs">{children}</div> : null}
          </div>
        </div>
        {actions ? (
          <div className="flex flex-wrap gap-2 pl-[3.25rem]">{actions}</div>
        ) : null}
      </Alert>
    </div>
  );
}

export function ViewLoadingSkeleton() {
  const { t } = useTranslation();
  return (
    <ViewStatusFrame
      tone="loading"
      icon={<LoaderCircle className="size-5 animate-spin" aria-hidden="true" />}
      title={t("dynamicviewloader.loading", { defaultValue: "Loading view…" })}
    />
  );
}

export function ViewRecoveryActions({
  onRetry,
  onBack,
}: {
  onRetry: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="tiny"
        className="gap-1"
        onClick={onRetry}
      >
        <RotateCw className="size-3.5" aria-hidden="true" />
        {t("dynamicviewloader.retry", { defaultValue: "Retry" })}
      </Button>
      <Button
        type="button"
        variant="ghostMuted"
        size="tiny"
        className="gap-1"
        onClick={onBack}
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        {t("dynamicviewloader.back", { defaultValue: "Back to views" })}
      </Button>
    </>
  );
}

export function ViewErrorState({
  viewId,
  error,
  onRetry,
  onBack,
}: {
  viewId: string;
  error?: Error | null;
  onRetry?: () => void;
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ViewStatusFrame
      tone="error"
      icon={<AlertTriangle className="size-5" aria-hidden="true" />}
      title={t("dynamicviewloader.error.title", {
        defaultValue: "Failed to load view",
      })}
      actions={
        onRetry && onBack ? (
          <ViewRecoveryActions onRetry={onRetry} onBack={onBack} />
        ) : undefined
      }
    >
      <span>
        {t("dynamicviewloader.viewId", {
          viewId,
          defaultValue: "View ID: {{viewId}}",
        })}
      </span>
      {error?.message ? (
        <span className="mt-1 block break-words font-mono text-xs">
          {error.message}
        </span>
      ) : null}
    </ViewStatusFrame>
  );
}

export function ViewRestrictedState({ viewId }: { viewId: string }) {
  const { t } = useTranslation();
  return (
    <ViewStatusFrame
      tone="restricted"
      icon={<Ban className="size-5" aria-hidden="true" />}
      title={t("dynamicviewloader.restricted.title", {
        defaultValue: "View not available on this platform",
      })}
    >
      <span>
        {t("dynamicviewloader.restricted.body", {
          defaultValue:
            "Dynamic views cannot be loaded on iOS or Android store builds.",
        })}
      </span>
      <span className="mt-1 block">
        {t("dynamicviewloader.viewId", {
          viewId,
          defaultValue: "View ID: {{viewId}}",
        })}
      </span>
    </ViewStatusFrame>
  );
}
