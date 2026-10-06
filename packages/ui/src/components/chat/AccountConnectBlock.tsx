import { accountProviderDisplayName } from "../accounts/account-provider-options";
/**
 * AccountConnectBlock — inline chat entry point for adding another provider
 * account (Claude / Codex).
 *
 * Emitted when the agent's CONNECT_ACCOUNT action returns an `accountConnect`
 * request on the assistant turn. For each offered provider it shows the
 * provider's display name, the current linked-account count, and an "Add
 * account" button that opens the existing, already-audited `AddAccountDialog`
 * OAuth / API-key flow inline. This block is ONLY an entry point + count
 * display — all account management still lives in `AddAccountDialog` /
 * `AccountList`; it never duplicates that UI.
 */

import type { LinkedAccountProviderId } from "@elizaos/host/protocol";
import { useMemo, useState } from "react";
import type { AccountConnectRequest } from "../../api/client-types-chat";
import { useAccounts } from "../../hooks/useAccounts";
import { useAppSelector } from "../../state/app-store";
import { AddAccountDialog } from "../accounts/AddAccountDialog";
import { Button } from "../ui/button";
import { Card } from "../ui/card";

/**
 * Human-readable provider name with a sensible English default. Mirrors the
 * `providerDisplayName` mapping inside `AddAccountDialog` (kept local so the
 * block reads a display label without pulling the dialog's private helper).
 */
export function AccountConnectBlock({
  request,
}: {
  request: AccountConnectRequest;
}) {
  const t = useAppSelector((s) => s.t);
  const accounts = useAccounts();
  const [openProvider, setOpenProvider] =
    useState<LinkedAccountProviderId | null>(null);
  const countByProvider = useMemo(() => {
    const map = new Map<LinkedAccountProviderId, number>();
    for (const p of accounts.data?.providers ?? []) {
      map.set(p.providerId, p.accounts.length);
    }
    return map;
  }, [accounts.data]);
  return (
    <Card
      variant="insetPadded"
      className="text-sm"
      data-testid="account-connect"
    >
      <div className="font-medium mb-1">
        {t("accounts.connect.heading", { defaultValue: "Add another account" })}
      </div>
      <div className="text-muted-strong whitespace-pre-wrap mb-3">
        {request.reason?.trim()
          ? request.reason
          : t("accounts.connect.subheading", {
              defaultValue:
                "Pick a provider to sign into another account. Your accounts rotate automatically.",
            })}
      </div>
      <div className="flex flex-col gap-2">
        {request.providers.map((providerId) => {
          const count = countByProvider.get(providerId) ?? 0;
          return (
            <Card
              variant="configRow"
              flow="rowBetween"
              gap="default"
              padding="compact"
              key={providerId}
              data-testid={`account-connect-row-${providerId}`}
            >
              <div className="min-w-0">
                <div className="truncate font-medium">
                  {accountProviderDisplayName(providerId, t)}
                </div>
                <div className="text-xs text-muted-strong">
                  {accounts.loading && !accounts.data
                    ? t("accounts.connect.loadingCount", {
                        defaultValue: "Loading accounts…",
                      })
                    : t("accounts.connect.currentCount", {
                        defaultValue: "{{count}} connected",
                        count,
                      })}
                </div>
              </div>
              <Button
                type="button"
                variant="default"
                size="sm"
                data-testid={`account-connect-add-${providerId}`}
                onClick={() => setOpenProvider(providerId)}
                className="shrink-0"
              >
                {t("accounts.add.button", { defaultValue: "Add account" })}
              </Button>
            </Card>
          );
        })}
      </div>
      {openProvider ? (
        <AddAccountDialog
          open
          providerId={openProvider}
          onClose={() => setOpenProvider(null)}
          onCreated={() => {
            // Refresh so the row count reflects the newly linked account.
            void accounts.refresh();
            setOpenProvider(null);
          }}
        />
      ) : null}
    </Card>
  );
}
