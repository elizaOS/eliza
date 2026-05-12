/**
 * AccountList — provider-scoped multi-account UI.
 *
 * Renders the rotation strategy picker, "Add account" button, and a
 * priority-ordered stack of `AccountCard`s for the given providerId.
 * Up/down reordering swaps priorities with the neighbour via two
 * sequential PATCH calls (no drag-drop dependency).
 */

import type { LinkedAccountProviderId } from "@elizaos/shared";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { AccountWithCredentialFlag } from "../../api/client-agent";
import { useAccounts } from "../../hooks/useAccounts";
import { useApp } from "../../state";
import { AccountCard } from "./AccountCard";
import { AddAccountDialog } from "./AddAccountDialog";
import { RotationStrategyPicker } from "./RotationStrategyPicker";

interface AccountListProps {
  providerId: LinkedAccountProviderId;
}

export function AccountList({ providerId }: AccountListProps) {
  const { t } = useApp();
  const accounts = useAccounts();
  const [addDialogOpen, setAddDialogOpen] = useState(false);

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

  if (accounts.loading && !accounts.data) {
    return (
      <div className="mt-3 flex items-center gap-2 text-xs text-muted">
        <Spinner className="h-3 w-3" />
        {t("accounts.loading", { defaultValue: "Loading accounts…" })}
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-xl border border-border/40 bg-bg-accent/40 p-3">
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
            onClick={() => setAddDialogOpen(true)}
            className="h-8 gap-1 px-2.5 text-xs"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t("accounts.add.button", { defaultValue: "Add account" })}
          </Button>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/50 px-3 py-6 text-center text-xs text-muted">
          {t("accounts.empty", {
            defaultValue:
              "No accounts yet — add one to start using this provider.",
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map((account, index) => (
            <AccountCard
              key={account.id}
              account={account}
              isFirst={index === 0}
              isLast={index === sorted.length - 1}
              saving={accounts.saving.has(account.id)}
              testBusy={accounts.saving.has(`test:${account.id}`)}
              refreshBusy={accounts.saving.has(`usage:${account.id}`)}
              onPatch={(body) => accounts.patch(providerId, account.id, body)}
              onMoveUp={() => handleMove(account.id, "up")}
              onMoveDown={() => handleMove(account.id, "down")}
              onTest={async () => {
                await accounts.test(providerId, account.id);
              }}
              onRefreshUsage={() =>
                accounts.refreshUsage(providerId, account.id)
              }
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
