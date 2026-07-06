/**
 * Renders the post-login permission soft-ask modal and its injected-controller
 * seam for tests and stories.
 */
import type { PermissionId } from "@elizaos/shared/contracts/permissions";
import {
  AudioLines,
  Bell,
  Camera,
  type LucideIcon,
  MapPin,
  Mic,
  ShieldCheck,
} from "lucide-react";
import * as React from "react";
import { appNameInterpolationVars, useBranding } from "../../config/branding";
import { useAppSelector } from "../../state/app-store";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { PermissionRecoveryCallout } from "./PermissionRecoveryCallout";
import { PRIMING_COPY } from "./permission-priming";
import {
  type PermissionPrimingController,
  usePermissionPriming,
} from "./use-permission-priming";

/**
 * Onboarding permission-priming modal — the "soft-ask" surface shown once,
 * post-login. For each relevant permission it presents *our* rationale and an
 * Enable / Not now choice; the real OS dialog only fires on Enable. Denied
 * permissions get an in-place recovery affordance (retry or open OS settings).
 *
 * This is a controlled dialog: the parent owns `open` and is told when the
 * sequence is finished via `onComplete` (granted, skipped, or dismissed).
 */

const ICONS: Record<string, LucideIcon> = {
  mic: Mic,
  "audio-lines": AudioLines,
  "map-pin": MapPin,
  bell: Bell,
  camera: Camera,
};

export interface PermissionPrimingModalProps {
  /** Ordered permissions to prime; resolved per-platform by the caller. */
  ids: PermissionId[];
  open: boolean;
  /** Fired once when the sequence completes (all resolved or dismissed). */
  onComplete: () => void;
  /** Test/story seam to inject a controller instead of the live hook. */
  controllerOverride?: PermissionPrimingController;
}

/**
 * Container: routes to the live hook, or an injected controller for
 * tests/stories. Splitting keeps the live `usePermissionPriming` (and its
 * on-mount OS status check) from running at all when a controller is supplied.
 */
export function PermissionPrimingModal(
  props: PermissionPrimingModalProps,
): React.JSX.Element {
  return props.controllerOverride ? (
    <PermissionPrimingModalView
      controller={props.controllerOverride}
      open={props.open}
      onComplete={props.onComplete}
    />
  ) : (
    <PermissionPrimingModalLive {...props} />
  );
}

function PermissionPrimingModalLive({
  ids,
  open,
  onComplete,
}: PermissionPrimingModalProps): React.JSX.Element {
  const controller = usePermissionPriming(ids);
  return (
    <PermissionPrimingModalView
      controller={controller}
      open={open}
      onComplete={onComplete}
    />
  );
}

function PermissionPrimingModalView({
  controller,
  open,
  onComplete,
}: {
  controller: PermissionPrimingController;
  open: boolean;
  onComplete: () => void;
}): React.JSX.Element {
  const {
    active,
    currentStep,
    totalSteps,
    ready,
    done,
    request,
    skip,
    recheck,
    skipAll,
  } = controller;

  const t = useAppSelector((s) => s.t);
  const branding = useBranding();

  // Fire onComplete exactly once when the sequence finishes.
  const completedRef = React.useRef(false);
  React.useEffect(() => {
    if (done && !completedRef.current) {
      completedRef.current = true;
      onComplete();
    }
  }, [done, onComplete]);

  const headerTitle = t("permissionpriming.title", {
    defaultValue: "Set up {{appName}}",
    ...appNameInterpolationVars(branding),
  });
  const headerSubtitle = t("permissionpriming.subtitle", {
    defaultValue: "A couple of quick permissions so I'm ready to help.",
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Dismissing (X / Escape / outside tap) soft-skips the rest; the parent
        // is then told via the done-effect.
        if (!next) skipAll();
      }}
    >
      <DialogContent
        showCloseButton
        data-testid="permission-priming-modal"
        aria-describedby="permission-priming-subtitle"
        // The completion edge leaves the chat sheet open at the HALF detent
        // (its container stacks at the shell-overlay level), so this modal
        // must sit above the ambient chat — content and dim both — or the
        // sheet paints over it and eats its taps (mobile bottom-sheet dialogs
        // and the half sheet are both bottom-anchored).
        className="z-[9500]"
        overlayClassName="z-[9490]"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-accent" aria-hidden />
            {headerTitle}
          </DialogTitle>
          <DialogDescription id="permission-priming-subtitle">
            {headerSubtitle}
          </DialogDescription>
        </DialogHeader>

        {!ready ? (
          <div
            className="py-8 text-center text-sm text-muted"
            data-testid="permission-priming-loading"
          >
            {t("permissionpriming.checking", {
              defaultValue: "Checking permissions…",
            })}
          </div>
        ) : active ? (
          <PrimingCard
            key={active.id}
            id={active.id}
            status={active.status}
            canRequest={active.canRequest}
            requesting={active.requesting}
            currentStep={currentStep}
            totalSteps={totalSteps}
            onEnable={() => void request(active.id)}
            onSkip={() => skip(active.id)}
            onRecheck={() => void recheck(active.id)}
            onSkipAll={skipAll}
          />
        ) : (
          <div
            className="py-8 text-center text-sm text-muted"
            data-testid="permission-priming-done"
          >
            {t("permissionpriming.allSet", { defaultValue: "You're all set." })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface PrimingCardProps {
  id: PermissionId;
  status: PermissionPrimingController["items"][number]["status"];
  canRequest: boolean;
  requesting: boolean;
  currentStep: number;
  totalSteps: number;
  onEnable: () => void;
  onSkip: () => void;
  onRecheck: () => void;
  onSkipAll: () => void;
}

function PrimingCard({
  id,
  status,
  canRequest,
  requesting,
  currentStep,
  totalSteps,
  onEnable,
  onSkip,
  onRecheck,
  onSkipAll,
}: PrimingCardProps): React.JSX.Element {
  const t = useAppSelector((s) => s.t);
  const copy = PRIMING_COPY[id];
  const Icon = copy ? (ICONS[copy.icon] ?? ShieldCheck) : ShieldCheck;
  const fallbackName = id.replaceAll("-", " ");
  const title = copy
    ? t(copy.titleKey, { defaultValue: copy.title })
    : t("permissionpriming.generic.title", {
        defaultValue: "Allow {{permission}}",
        permission: fallbackName,
      });
  const rationale = copy
    ? t(copy.rationaleKey, { defaultValue: copy.rationale })
    : t("permissionpriming.generic.rationale", {
        defaultValue:
          "Enable this permission so I can complete the request you just made.",
        permission: fallbackName,
      });

  const denied = status === "denied";

  return (
    <div className="flex flex-col gap-4" data-testid={`priming-card-${id}`}>
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-border bg-bg-accent text-accent">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="text-base font-semibold text-txt-strong">{title}</div>
          <p className="mt-1 text-sm leading-snug text-txt">{rationale}</p>
        </div>
      </div>

      {denied ? (
        <PermissionRecoveryCallout
          permission={id}
          title={t("permissionpriming.deniedTitle", {
            defaultValue: "Permission was declined",
          })}
          description={
            canRequest
              ? t("permissionpriming.deniedRetry", {
                  defaultValue:
                    "You can try again, or turn it on later in Settings.",
                })
              : t("permissionpriming.deniedSettings", {
                  defaultValue:
                    "To enable it, open Settings and allow access, then re-check.",
                })
          }
          retryLabel={
            canRequest
              ? t("permissionpriming.tryAgain", { defaultValue: "Try again" })
              : t("permissionpriming.iveEnabledIt", {
                  defaultValue: "I've enabled it",
                })
          }
          onRetry={canRequest ? onEnable : onRecheck}
          testId={`priming-recovery-${id}`}
        />
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted" data-testid="priming-progress">
          {t("permissionpriming.stepOf", {
            defaultValue: "Step {{current}} of {{total}}",
            current: currentStep,
            total: totalSteps,
          })}
        </span>
        <div className="flex items-center gap-2">
          {denied ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onSkip}
              data-testid={`priming-skip-${id}`}
            >
              {t("permissionpriming.continue", { defaultValue: "Continue" })}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onSkip}
                disabled={requesting}
                data-testid={`priming-skip-${id}`}
              >
                {t("permissionpriming.notNow", { defaultValue: "Not now" })}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="default"
                onClick={onEnable}
                disabled={requesting}
                data-testid={`priming-enable-${id}`}
              >
                {requesting
                  ? t("permissionpriming.requesting", {
                      defaultValue: "Requesting…",
                    })
                  : t("permissionpriming.enable", { defaultValue: "Enable" })}
              </Button>
            </>
          )}
        </div>
      </div>

      <button
        type="button"
        className="self-center text-xs text-muted underline-offset-2 hover:text-txt hover:underline"
        onClick={onSkipAll}
        data-testid="priming-skip-all"
      >
        {t("permissionpriming.skipAll", { defaultValue: "Skip for now" })}
      </button>
    </div>
  );
}
