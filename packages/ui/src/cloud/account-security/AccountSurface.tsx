/**
 * Account surface — profile form, organization info, account details. Gates on
 * the Steward session via {@link useUserProfile} and renders the account body.
 * Mounted by the `cloud-account` Settings section (`/settings#cloud-account`).
 */

import { useCallback } from "react";
import { useAgentElement } from "../../agent-surface";
import { useSetPageHeader } from "../../cloud-ui";
import { ContentState } from "../../components/composites/page-panel/content-state";
import { Button } from "../../components/ui/button";
import { buildSameTabCloudLoginPath } from "../../state/cloud-login-launch";
import { useDocumentTitle } from "../lib/use-document-title";
import { useCloudT } from "../shell/CloudI18nProvider";
import { AccountPageClient } from "./components/account-page-client";
import { useUserProfile } from "./data/user";

export interface AccountSurfaceProps {
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
    id: "cloud-account-sign-in",
    role: "button",
    label,
    group: "cloud-account",
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

/** The account surface. Assumes a `PageHeaderProvider` ancestor. */
export function AccountSurface({
  onSignIn,
  signInBusy = false,
}: AccountSurfaceProps = {}) {
  const t = useCloudT();
  const { user, isPending, isReady, isAuthenticated, isError, error, refetch } =
    useUserProfile();

  useSetPageHeader({
    title: t("cloud.account.headerTitle", { defaultValue: "Account" }),
    description: t("cloud.account.headerDescription", {
      defaultValue: "Manage your account preferences and profile information",
    }),
  });

  useDocumentTitle(
    t("cloud.account.metaTitle", { defaultValue: "Account Settings" }),
  );

  const loadingLabel = t("cloud.account.loading", {
    defaultValue: "Loading account",
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
        title={t("cloud.account.signInTitle", {
          defaultValue: "Sign in required",
        })}
        description={t("cloud.account.signInDescription", {
          defaultValue: "Sign in to manage your Eliza Cloud account.",
        })}
        action={
          onSignIn ? (
            <InteractiveSignInButton
              busy={signInBusy}
              label={signInLabel}
              onSignIn={onSignIn}
            />
          ) : (
            <Button asChild className="keyboard-focus-surface">
              <a href={buildSameTabCloudLoginPath()}>{signInLabel}</a>
            </Button>
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
        title={t("cloud.account.loadErrorTitle", {
          defaultValue: "Account unavailable",
        })}
        description={
          error instanceof Error
            ? error.message
            : t("cloud.account.loadError", {
                defaultValue: "Failed to load account",
              })
        }
        action={
          <Button
            type="button"
            variant="outlineAccent"
            className="keyboard-focus-surface"
            onClick={() => void refetch()}
          >
            {t("settings.sectionRetry", { defaultValue: "Retry" })}
          </Button>
        }
      />
    );
  }

  if (!user) {
    return (
      <ContentState
        state="empty"
        placement="surface"
        title={t("cloud.account.unavailableTitle", {
          defaultValue: "Account unavailable",
        })}
        description={t("cloud.account.unavailableDescription", {
          defaultValue:
            "Your session is active, but no account profile is available.",
        })}
      />
    );
  }

  return <AccountPageClient user={user} />;
}
