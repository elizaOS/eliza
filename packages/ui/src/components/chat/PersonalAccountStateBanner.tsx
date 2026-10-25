/**
 * Chat banner for the personal Eliza Dedicated-to-Shared fallback (#25146).
 * Renders the server's typed account state as-is: why Dedicated access is
 * paused, that Dedicated memory is unavailable until billing is restored, how
 * long the Dedicated agent is kept, and the pay action (the signed recovery
 * link, else the signed-in billing page). A 503 between runtimes renders a
 * retryable state. Nothing is shown for an account the server did not report.
 */

import { useCallback, useEffect, useState } from "react";
import { client } from "../../api/client";
import {
  type PersonalFallbackAccountState,
  personalFallbackRecoveryUrl,
} from "../../api/personal-fallback";
import { cloudBillingConsoleUrl } from "../../cloud/billing-console";
import { logger } from "../../logger.ts";
import {
  type PersonalFallbackView,
  refreshPersonalRoute,
  usePersonalFallbackView,
} from "../../state/personal-fallback-route";
import { openExternalUrl } from "../../utils/openExternalUrl";
import { Banner } from "../ui/banner";
import { Button } from "../ui/button";

type Translate = (key: string, values?: Record<string, unknown>) => string;

function reasonText(
  t: Translate,
  reason: PersonalFallbackAccountState["reason"],
): string {
  switch (reason) {
    case "billing_suspended":
      return t("chat.personalFallback.reason.billingSuspended", {
        defaultValue:
          "Your Dedicated Eliza is paused because your account is out of credits.",
      });
    case "subscription_payment_failed":
      return t("chat.personalFallback.reason.paymentFailed", {
        defaultValue:
          "Your Dedicated Eliza is paused because a subscription payment failed.",
      });
    case "subscription_ended":
      return t("chat.personalFallback.reason.subscriptionEnded", {
        defaultValue:
          "Your Dedicated Eliza is paused because your subscription ended.",
      });
  }
}

function formatDeadline(iso: string, locale: string | undefined): string {
  return new Date(iso).toLocaleDateString(locale, { dateStyle: "long" });
}

function SharedFallbackBanner({
  view,
  t,
  locale,
}: {
  view: Extract<PersonalFallbackView, { status: "shared_fallback" }>;
  t: Translate;
  locale?: string;
}) {
  const { accountState, cloudApiBase } = view;
  const openRecovery = useCallback(() => {
    const url = personalFallbackRecoveryUrl(
      accountState,
      cloudBillingConsoleUrl(cloudApiBase),
      cloudApiBase,
    );
    void openExternalUrl(url);
  }, [accountState, cloudApiBase]);

  if (accountState.state === "recovery_pending") {
    return (
      <Banner variant="info" data-testid="personal-fallback-banner">
        {t("chat.personalFallback.recoveryPending", {
          defaultValue:
            "Billing is restored and your Dedicated Eliza is restarting. Shared Eliza keeps answering until it is back.",
        })}
      </Banner>
    );
  }
  const deadline = accountState.dedicatedRetainedUntil;
  return (
    <Banner
      variant="warning"
      data-testid="personal-fallback-banner"
      action={
        <Button
          size="dense"
          variant="default"
          onClick={openRecovery}
          data-testid="personal-fallback-pay"
        >
          {accountState.recoveryAction.kind === "add_credits"
            ? t("chat.personalFallback.addCredits", {
                defaultValue: "Add credits",
              })
            : t("chat.personalFallback.restoreSubscription", {
                defaultValue: "Restore subscription",
              })}
        </Button>
      }
    >
      <span className="block font-medium">
        {reasonText(t, accountState.reason)}
      </span>
      <span className="block">
        {t("chat.personalFallback.sharedActive", {
          defaultValue:
            "You're chatting with Shared Eliza. Your Dedicated memory is unavailable until billing is restored.",
        })}
      </span>
      {deadline ? (
        <span className="block">
          {t("chat.personalFallback.retainedUntil", {
            defaultValue: "Your Dedicated Eliza is kept until {{date}}.",
            date: formatDeadline(deadline, locale),
          })}
        </span>
      ) : null}
    </Banner>
  );
}

function RetryingBanner({
  view,
  t,
}: {
  view: Extract<PersonalFallbackView, { status: "retrying" }>;
  t: Translate;
}) {
  const [checking, setChecking] = useState(false);
  const retry = useCallback(async () => {
    setChecking(true);
    try {
      const outcome = await refreshPersonalRoute();
      if (outcome.status === "failed") {
        logger.warn(
          `[PersonalAccountStateBanner] route retry failed: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
        );
      }
    } finally {
      setChecking(false);
    }
  }, []);

  // Honor the server's Retry-After once; the button stays for a manual retry.
  const { retryAfterSeconds } = view;
  useEffect(() => {
    if (!retryAfterSeconds) return;
    const timer = setTimeout(() => {
      void retry();
    }, retryAfterSeconds * 1000);
    return () => clearTimeout(timer);
  }, [retryAfterSeconds, retry]);

  return (
    <Banner
      variant="info"
      data-testid="personal-fallback-retrying"
      action={
        <Button
          size="dense"
          variant="outline"
          disabled={checking}
          onClick={() => void retry()}
          data-testid="personal-fallback-retry"
        >
          {t("chat.personalFallback.retry", { defaultValue: "Try again" })}
        </Button>
      }
    >
      {view.code === "dedicated_reconciling"
        ? t("chat.personalFallback.reconciling", {
            defaultValue:
              "Your Dedicated Eliza is restoring your recent conversation. This usually takes a few seconds.",
          })
        : t("chat.personalFallback.fallbackPending", {
            defaultValue:
              "Your Eliza is switching to Shared. This usually takes a few seconds.",
          })}
    </Banner>
  );
}

export function PersonalAccountStateBanner({
  t,
  locale,
}: {
  t: Translate;
  locale?: string;
}) {
  const view = usePersonalFallbackView();

  // Resolve on mount and whenever the chat's runtime base changes; a base
  // that is not the personal Shared identity clears the banner.
  useEffect(() => {
    const refresh = () => {
      void refreshPersonalRoute().then((outcome) => {
        if (outcome.status === "failed") {
          logger.warn(
            `[PersonalAccountStateBanner] personal route lookup failed: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
          );
        }
      });
    };
    refresh();
    return client.onBaseUrlChange(refresh);
  }, []);

  return <PersonalFallbackBannerView view={view} t={t} locale={locale} />;
}

/** Presentational banner for one resolved fallback view. */
export function PersonalFallbackBannerView({
  view,
  t,
  locale,
}: {
  view: PersonalFallbackView;
  t: Translate;
  locale?: string;
}) {
  if (view.status === "shared_fallback") {
    return <SharedFallbackBanner view={view} t={t} locale={locale} />;
  }
  if (view.status === "retrying") {
    return <RetryingBanner view={view} t={t} />;
  }
  return null;
}
