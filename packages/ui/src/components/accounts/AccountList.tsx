/**
 * AccountList — provider-scoped multi-account UI.
 *
 * Renders the rotation strategy picker, "Add account" button, and a
 * priority-ordered stack of `AccountCard`s for the given providerId.
 * Up/down reordering swaps priorities with the neighbour via two
 * sequential PATCH calls (no drag-drop dependency).
 */

import type { LinkedAccountProviderId } from "@elizaos/shared";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AccountWithCredentialFlag } from "../../api/client-agent";
import { useAccounts } from "../../hooks/useAccounts";
import { useAppSelector } from "../../state/app-store";
import { Button } from "../ui/button";
import { AccountCard } from "./AccountCard";
import { AccountListShell } from "./AccountListShell";
import { AddAccountDialog } from "./AddAccountDialog";
import { RotationStrategyPicker } from "./RotationStrategyPicker";
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
  const [credentialRepairAccount, setCredentialRepairAccount] =
    useState<AccountWithCredentialFlag | null>(null);

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
        ? [...providerEntry.accounts].sort(
            (a, b) =>
              (Number.isFinite(a.priority) ? a.priority : 0) -
              (Number.isFinite(b.priority) ? b.priority : 0),
          )
        : [],
    [providerEntry],
  );

  const handleMove = useCallback(
    async (accountId: string, direction: "up" | "down") => {
      const index = sorted.findIndex((a) => a.id === accountId);
      if (index < 0) return;
      const neighbourIndex = direction === "up" ? index - 1 : index + 1;
      if (neighbourIndex < 0 || neighbourIndex >= sorted.length) return;
      const self = sorted[index];
      const neighbour = sorted[neighbourIndex];
      if (!self || !neighbour || self.priority === neighbour.priority) return;
      const selfOriginal = self.priority;
      const neighbourOriginal = neighbour.priority;
      // Swap priorities via two sequential PATCHes. There's no atomic
      // server-side swap, so on failure of the second call we roll the
      // first one back so the user doesn't end up with two accounts at
      // the same priority. Worst case a partial-failure leaves the
      // original ordering with a flash; never a corrupted ordering.
      await accounts.patch(providerId, self.id, {
        priority: neighbourOriginal,
      });
      try {
        await accounts.patch(providerId, neighbour.id, {
          priority: selfOriginal,
        });
      } catch (err) {
        try {
          await accounts.patch(providerId, self.id, {
            priority: selfOriginal,
          });
        } catch {
          // Rollback failed — refresh will reconcile from server state.
          void accounts.refresh();
        }
        throw err;
      }
    },
    [accounts, providerId, sorted],
  );

  const listState =
    accounts.loading && !accounts.data
      ? {
          kind: "loading" as const,
          label: t("accounts.loading", { defaultValue: "Loading accounts…" }),
        }
      : accounts.error && !accounts.data
        ? {
            kind: "error" as const,
            message: accounts.error,
            action: (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void accounts.refresh()}
                className="shrink-0"
              >
                {t("common.retry", { defaultValue: "Retry" })}
              </Button>
            ),
          }
        : sorted.length === 0
          ? {
              kind: "empty" as const,
              message: t("accounts.empty", {
                defaultValue:
                  "No accounts yet — add one to start using this provider.",
              }),
            }
          : {
              kind: "ready" as const,
              children: sorted.map((account, index) => (
                <AccountCard
                  key={account.id}
                  account={account}
                  isFirst={index === 0}
                  isLast={index === sorted.length - 1}
                  saving={accounts.saving.has(account.id)}
                  testBusy={accounts.saving.has(`test:${account.id}`)}
                  refreshBusy={accounts.saving.has(`usage:${account.id}`)}
                  onPatch={(body) =>
                    accounts.patch(providerId, account.id, body)
                  }
                  onMoveUp={() => handleMove(account.id, "up")}
                  onMoveDown={() => handleMove(account.id, "down")}
                  onTest={async () => {
                    await accounts.test(providerId, account.id);
                  }}
                  onRefreshUsage={() =>
                    accounts.refreshUsage(providerId, account.id)
                  }
                  onDelete={() => accounts.remove(providerId, account.id)}
                  onReauthenticate={() => {
                    setCredentialRepairAccount(account);
                    setAddDialogOpen(true);
                  }}
                />
              )),
            };

  return (
    <>
      <AccountListShell
        heading={t("accounts.heading", {
          defaultValue: "Accounts ({{count}})",
          count: sorted.length,
        })}
        action={
          <div className="flex items-center gap-2">
            <RotationStrategyPicker
              providerId={providerId}
              value={providerEntry?.strategy}
              onChange={(strategy) => {
                void accounts.setStrategy(providerId, strategy);
              }}
              disabled={accounts.saving.has(`strategy:${providerId}`)}
            />
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => {
                setCredentialRepairAccount(null);
                setAddDialogOpen(true);
              }}
            >
              <Plus className="size-3.5" aria-hidden />
              {t("accounts.add.button", { defaultValue: "Add account" })}
            </Button>
          </div>
        }
        state={listState}
      />

      <AddAccountDialog
        open={addDialogOpen}
        providerId={providerId}
        credentialRepairAccount={credentialRepairAccount}
        onClose={() => {
          setAddDialogOpen(false);
          setCredentialRepairAccount(null);
        }}
        onCreated={(account) => {
          // The dialog owns the create request. Adopt its successful response
          // immediately, then reconcile any server-side defaults in the same
          // refresh so a slow list request cannot leave a stale empty card.
          void accounts.refresh({ providerId, account });
        }}
      />
    </>
  );
}
