/**
 * Canonical billing surface — the body mounted by the `cloud-billing` Settings
 * section (`/settings#cloud-billing`) and the standalone `dashboard/billing`
 * console page.
 *
 * Fetches the current user/account (the `BillingTab` needs a freshly confirmed
 * billing identity), then renders the consumer billing controls. Balance and
 * active compute come from the canonical billing snapshot v2. Internal
 * infrastructure quotas remain available to their owning diagnostics surfaces;
 * they are not part of the normal billing experience.
 * Wraps the subtree in {@link ConditionalWalletProviders} so the crypto
 * direct-payment wallet stack (wagmi/RainbowKit/Solana) never enters the entry
 * bundle elsewhere.
 *
 * The Stripe Checkout cancel URL points back here with `?canceled=true` (it
 * targets `/cloud/billing`, the standalone console page that mounts this
 * same body), so the canceled banner renders at the top of the body.
 */

import { useCallback } from "react";
import { useAgentElement } from "../../agent-surface";
import { ContentState } from "../../components/composites/page-panel/content-state";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { buildSameTabCloudLoginPath } from "../../state/cloud-login-launch";
import { useCloudT } from "../shell/CloudI18nProvider";
import { BillingTab } from "./components/billing-tab";
import { useBillingUser } from "./data/billing-data";
import { ConditionalWalletProviders } from "./wallet/ConditionalWalletProviders";

function wasCheckoutCanceled(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("canceled") !== null;
}

/** Optional host login integration for the signed-out Billing state. */
export interface BillingSectionBodyProps {
  onSignIn?: () => void;
  signInBusy?: boolean;
}

interface InteractiveSignInButtonProps {
  busy: boolean;
  label: string;
  onSignIn: () => void;
}

function InteractiveSignInButton({
  busy,
  label,
  onSignIn,
}: InteractiveSignInButtonProps) {
  const handleAgentActivate = useCallback(() => {
    if (!busy) onSignIn();
  }, [busy, onSignIn]);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "cloud-billing-sign-in",
    role: "button",
    label,
    group: "cloud-billing",
    status: busy ? "pending" : "available",
    clickable: !busy,
    onActivate: handleAgentActivate,
  });

  return (
    <Button
      ref={ref}
      type="button"
      className="keyboard-focus-surface"
      onClick={onSignIn}
      disabled={busy}
      aria-busy={busy || undefined}
      {...agentProps}
    >
      {label}
    </Button>
  );
}

interface SignInLinkProps {
  href: string;
  label: string;
}

function SignInLink({ href, label }: SignInLinkProps) {
  const { ref, agentProps } = useAgentElement<HTMLAnchorElement>({
    id: "cloud-billing-sign-in",
    role: "link",
    label,
    group: "cloud-billing",
    status: "available",
    clickable: true,
  });

  return (
    <Button asChild className="keyboard-focus-surface">
      <a ref={ref} href={href} {...agentProps}>
        {label}
      </a>
    </Button>
  );
}

interface RetryButtonProps {
  busy: boolean;
  label: string;
  onRetry: () => void;
}

function RetryButton({ busy, label, onRetry }: RetryButtonProps) {
  const handleAgentActivate = useCallback(() => {
    if (!busy) onRetry();
  }, [busy, onRetry]);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "cloud-billing-retry",
    role: "button",
    label,
    group: "cloud-billing",
    status: busy ? "pending" : "available",
    clickable: !busy,
    onActivate: handleAgentActivate,
  });

  return (
    <Button
      ref={ref}
      type="button"
      variant="outlineAccent"
      className="keyboard-focus-surface"
      onClick={onRetry}
      disabled={busy}
      aria-busy={busy || undefined}
      {...agentProps}
    >
      {label}
    </Button>
  );
}

/** The billing surface, rendered by the Settings → Cloud billing section. */
export function BillingSectionBody({
  onSignIn,
  signInBusy = false,
}: BillingSectionBodyProps = {}) {
  const t = useCloudT();
  const {
    user,
    isPending,
    isFetching,
    isPaused,
    isFetchedAfterMount,
    isReady,
    isAuthenticated,
    isError,
    error,
    refetch,
  } = useBillingUser({ requireFreshOrganization: true });
  const loadingLabel = t("cloud.billing.loading", {
    defaultValue: "Loading billing",
  });
  const signInLabel = t("cloud.login.signIn", { defaultValue: "Sign in" });

  if (!isReady) {
    return (
      <ContentState
        state="loading"
        placement="surface"
        heading={loadingLabel}
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label={loadingLabel}
      />
    );
  }

  if (!isAuthenticated) {
    return (
      <ContentState
        state="empty"
        placement="surface"
        title={t("cloud.billing.signInTitle", {
          defaultValue: "Sign in required",
        })}
        description={t("cloud.billing.signInDescription", {
          defaultValue: "Sign in to manage billing and Eliza Cloud credits.",
        })}
        action={
          onSignIn ? (
            <InteractiveSignInButton
              busy={signInBusy}
              label={signInLabel}
              onSignIn={onSignIn}
            />
          ) : (
            <SignInLink
              href={buildSameTabCloudLoginPath()}
              label={signInLabel}
            />
          )
        }
      />
    );
  }

  if (isPending) {
    return (
      <ContentState
        state="loading"
        placement="surface"
        heading={loadingLabel}
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label={loadingLabel}
      />
    );
  }

  if (isError) {
    return (
      <ContentState
        state="error"
        placement="surface"
        title={t("cloud.billing.loadErrorTitle", {
          defaultValue: "Billing unavailable",
        })}
        description={
          error instanceof Error
            ? error.message
            : t("cloud.billing.loadError", {
                defaultValue: "Failed to load billing",
              })
        }
        action={
          <RetryButton
            busy={isFetching || isPaused}
            label={
              isFetching || isPaused
                ? t("cloud.billing.retrying", { defaultValue: "Retrying…" })
                : t("settings.sectionRetry", { defaultValue: "Retry" })
            }
            onRetry={() => void refetch()}
          />
        }
      />
    );
  }

  if (isFetching || isPaused || !isFetchedAfterMount) {
    return (
      <ContentState
        state="loading"
        placement="surface"
        heading={loadingLabel}
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label={loadingLabel}
      />
    );
  }

  if (!user) {
    return (
      <ContentState
        state="empty"
        placement="surface"
        title={t("cloud.billing.unavailableTitle", {
          defaultValue: "Billing unavailable",
        })}
        description={t("cloud.billing.unavailableDescription", {
          defaultValue:
            "Your session is active, but no billing account is available.",
        })}
      />
    );
  }

  return (
    <ConditionalWalletProviders>
      {wasCheckoutCanceled() ? (
        <Alert variant="dashboardError" className="mb-4">
          {t("cloud.billing.paymentCanceled", {
            defaultValue: "Payment canceled. No charges were made.",
          })}
        </Alert>
      ) : null}
      <BillingTab user={user} />
    </ConditionalWalletProviders>
  );
}
