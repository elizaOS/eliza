/**
 * AccountList — provider-scoped multi-account UI.
 *
 * Renders a provider's round-robin subscription pool. Account ordering and
 * strategy controls are intentionally absent: every enabled healthy account
 * participates automatically.
 */

import type { LinkedAccountProviderId } from "@elizaos/shared";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AccountWithCredentialFlag } from "../../api/client-agent";
import { useAccounts } from "../../hooks/useAccounts";
import { useAppSelector } from "../../state";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { AccountCard } from "./AccountCard";
import { AddAccountDialog } from "./AddAccountDialog";
import { readSubscriptionOAuth } from "./subscription-oauth-state";

interface AccountListProps {
  providerId: LinkedAccountProviderId;
}

export function AccountList({ providerId }: AccountListProps) {
  const t = useAppSelector((s) => s.t);
  const accounts = useAccounts();
  const [addDialogOpen, setAddDialogOpen] = useState(
    () => readSubscriptionOAuth(providerId) !== null,
  );

  useEffect(() => {
    const restorePendingDialog = () => {
      if (readSubscriptionOAuth(providerId)) setAddDialogOpen(true);
    };
    restorePendingDialog();
    window.addEventListener("focus", restorePendingDialog);
    window.addEventListener("pageshow", restorePendingDialog);
    document.addEventListener("visibilitychange", restorePendingDialog);
    return () => {
      window.removeEventListener("focus", restorePendingDialog);
      window.removeEventListener("pageshow", restorePendingDialog);
      document.removeEventListener("visibilitychange", restorePendingDialog);
    };
  }, [providerId]);

  const providerEntry = useMemo(
    () => accounts.data?.providers.find((p) => p.providerId === providerId),
    [accounts.data, providerId],
  );

  const sorted: AccountWithCredentialFlag[] = useMemo(
    () =>
      providerEntry
        ? [...providerEntry.accounts].sort((a, b) => a.priority - b.priority)
        : [],
    [providerEntry],
  );

  if (accounts.loading && !accounts.data) {
    return (
      <div className="mt-3 flex items-center gap-2 text-xs text-muted">
        <Spinner className="h-3 w-3" />
        {t("accounts.loading", { defaultValue: "Loading accounts…" })}
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-sm border border-border/40 bg-bg-accent/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
            {t("accounts.heading", {
              defaultValue: "Accounts ({{count}})",
              count: sorted.length,
            })}
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => setAddDialogOpen(true)}
            className="h-8 gap-1 px-2.5 text-xs"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t("accounts.add.button", { defaultValue: "Add account" })}
          </Button>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-sm border border-dashed border-border/50 px-3 py-6 text-center text-xs text-muted">
          {t("accounts.empty", {
            defaultValue:
              "No accounts yet — add one to start using this provider.",
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              saving={accounts.saving.has(account.id)}
              testBusy={accounts.saving.has(`test:${account.id}`)}
              refreshBusy={accounts.saving.has(`usage:${account.id}`)}
              onPatch={(body) => accounts.patch(providerId, account.id, body)}
              onTest={async () => {
                await accounts.test(providerId, account.id);
              }}
              onRefreshUsage={() =>
                accounts.refreshUsage(providerId, account.id)
              }
              onReauthenticate={() => setAddDialogOpen(true)}
              onDelete={() => accounts.remove(providerId, account.id)}
            />
          ))}
        </div>
      )}

      <AddAccountDialog
        open={addDialogOpen}
        providerId={providerId}
        onClose={() => setAddDialogOpen(false)}
        onCreated={() => {
          // useAccounts already injects the new entry on success, so
          // there's nothing to do here. Refresh anyway in case the
          // optimistic insert missed a server-side default.
          void accounts.refresh();
        }}
      />
    </div>
  );
}
