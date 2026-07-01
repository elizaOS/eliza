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

import type { LinkedAccountProviderId } from "@elizaos/shared";
import { useMemo, useState } from "react";
import type { AccountConnectRequest } from "../../api/client-types-chat";
import { useAccounts } from "../../hooks/useAccounts";
import { useAppSelector } from "../../state";
import { AddAccountDialog } from "../accounts/AddAccountDialog";
import { Button } from "../ui/button";

/**
 * Human-readable provider name with a sensible English default. Mirrors the
 * `providerDisplayName` mapping inside `AddAccountDialog` (kept local so the
 * block reads a display label without pulling the dialog's private helper).
 */
function providerLabel(
  providerId: LinkedAccountProviderId,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  switch (providerId) {
    case "anthropic-subscription":
      return t("accounts.provider.anthropicSubscription", {
        defaultValue: "Claude Subscription",
      });
    case "openai-codex":
      return t("accounts.provider.openaiCodex", {
        defaultValue: "OpenAI Codex",
      });
    case "gemini-cli":
      return t("accounts.provider.geminiCli", { defaultValue: "Gemini CLI" });
    case "zai-coding":
      return t("accounts.provider.zaiCoding", {
        defaultValue: "z.ai Coding Plan",
      });
    case "kimi-coding":
      return t("accounts.provider.kimiCoding", { defaultValue: "Kimi Code" });
    case "deepseek-coding":
      return t("accounts.provider.deepseekCoding", {
        defaultValue: "DeepSeek Coding Plan",
      });
    case "anthropic-api":
      return t("accounts.provider.anthropicApi", {
        defaultValue: "Anthropic API",
      });
    case "openai-api":
      return t("accounts.provider.openaiApi", { defaultValue: "OpenAI API" });
    case "deepseek-api":
      return t("accounts.provider.deepseekApi", {
        defaultValue: "DeepSeek API",
      });
    case "zai-api":
      return t("accounts.provider.zaiApi", { defaultValue: "z.ai API" });
    case "moonshot-api":
      return t("accounts.provider.moonshotApi", {
        defaultValue: "Kimi / Moonshot API",
      });
    case "cerebras-api":
      return t("accounts.provider.cerebrasApi", {
        defaultValue: "Cerebras API",
      });
    default:
      return providerId;
  }
}

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
    <div
      data-testid="account-connect"
      className="border border-border/60 bg-card rounded-sm p-3 text-sm"
    >
      <div className="font-medium mb-1">
        {t("accounts.connect.heading", { defaultValue: "Add another account" })}
      </div>
      <div className="text-muted whitespace-pre-wrap mb-3">
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
            <div
              key={providerId}
              data-testid={`account-connect-row-${providerId}`}
              className="flex items-center justify-between gap-3 rounded-sm border border-border/40 bg-bg-accent/40 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">
                  {providerLabel(providerId, t)}
                </div>
                <div className="text-xs text-muted">
                  {accounts.loading && !accounts.data
                    ? t("accounts.connect.loadingCount", {
                        defaultValue: "Loading accounts…",
                      })
                    : t("accounts.connect.currentCount", {
                        defaultValue: `${count} connected`,
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
            </div>
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
    </div>
  );
}
