/**
 * Card for one connector account in the account-management list: shows
 * status/role/privacy, an editable label, and the per-account actions (set
 * default, sync, privacy/purpose edit, delete-with-confirmation). Edits are
 * sent as `ConnectorAccountUpdateInput` through the parent's callbacks; delete
 * goes through a confirmation dialog. When the provider declares an OAuth
 * capability catalog the card also renders the unified capability chip strip
 * (granted / missing-with-Grant / access-not-reported) and a Reconnect
 * affordance for reauth-required accounts (#19884).
 */

import type { ConnectorOAuthCapabilityDeclaration } from "@elizaos/shared/connector-account-catalog";
import { KeyRound, RefreshCw, Star, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import type {
  ConnectorAccountRecord,
  ConnectorAccountStatus,
  ConnectorAccountUpdateInput,
} from "../../api/client-agent";
import { useModalState } from "../../hooks/useModalState";
import {
  type TranslationContextValue,
  useTranslation,
} from "../../state/TranslationContext.hooks";
import { EditableAccountLabel } from "../accounts/EditableAccountLabel";
import { ConnectedCapabilityChips } from "../capabilities/ConnectedCapabilityChips";
import {
  presentConnectorAccountStatus,
  presentConnectorCapabilityChips,
  readConnectorAccountCapabilityAccess,
} from "../capabilities/connected-capability-presentation";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { StatusBadge } from "../ui/status-badge";
import { ConnectorAccountPrivacySelector } from "./ConnectorAccountPrivacySelector";
import { ConnectorAccountPurposeSelector } from "./ConnectorAccountPurposeSelector";

export interface ConnectorAccountCardProps {
  account: ConnectorAccountRecord;
  isDefault?: boolean;
  selected?: boolean;
  saving?: boolean;
  testBusy?: boolean;
  refreshBusy?: boolean;
  onSelect?: () => void;
  onUpdate: (body: ConnectorAccountUpdateInput) => Promise<void>;
  onTest: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onDelete: () => Promise<void>;
  onMakeDefault: () => Promise<void>;
  /**
   * Provider-declared least-privilege capability catalog. When present the
   * card renders the unified capability chip strip (#19884); when absent the
   * provider has no declared capability model and the strip is omitted.
   */
  declaredCapabilities?: readonly ConnectorOAuthCapabilityDeclaration[];
  /** Starts an incremental-scope OAuth restart for one missing capability. */
  onGrantCapability?: (capabilityId: string) => void;
  grantBusyCapabilityId?: string | null;
  /** Re-runs OAuth for this account when it needs reauthentication. */
  onReconnect?: () => void;
  reconnectBusy?: boolean;
}

/** Status label only — the tone comes from the shared capability vocabulary
 * (`presentConnectorAccountStatus`) so Connections and Permissions agree. */
interface StatusInfo {
  label: string;
}

type TranslateFn = TranslationContextValue["t"];

function formatRelativeTime(
  epochMs: number | undefined,
  t: TranslateFn,
): string {
  if (!epochMs)
    return t("connectoraccount.sync.never", { defaultValue: "Never synced" });
  const diff = Date.now() - epochMs;
  if (diff < 60_000)
    return t("connectoraccount.sync.justNow", {
      defaultValue: "Synced just now",
    });
  if (diff < 3_600_000)
    return t("connectoraccount.sync.minutes", {
      minutes: Math.floor(diff / 60_000),
      defaultValue: "Synced {{minutes}}m ago",
    });
  if (diff < 86_400_000)
    return t("connectoraccount.sync.hours", {
      hours: Math.floor(diff / 3_600_000),
      defaultValue: "Synced {{hours}}h ago",
    });
  return t("connectoraccount.sync.days", {
    days: Math.floor(diff / 86_400_000),
    defaultValue: "Synced {{days}}d ago",
  });
}

function deriveStatus(
  status: ConnectorAccountStatus | undefined,
  t: TranslateFn,
): StatusInfo {
  switch (status) {
    case "connected":
      return {
        label: t("connectoraccount.status.connected", {
          defaultValue: "Connected",
        }),
      };
    case "pending":
      return {
        label: t("connectoraccount.status.pending", {
          defaultValue: "Pending",
        }),
      };
    case "needs-reauth":
      return {
        label: t("connectoraccount.status.needsReauth", {
          defaultValue: "Needs reauth",
        }),
      };
    case "error":
      return {
        label: t("connectoraccount.status.error", { defaultValue: "Error" }),
      };
    case "disconnected":
      return {
        label: t("connectoraccount.status.disconnected", {
          defaultValue: "Disconnected",
        }),
      };
    default:
      return {
        label: t("connectoraccount.status.unknown", {
          defaultValue: "Unknown",
        }),
      };
  }
}

function initials(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "?";
  return trimmed
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

export function ConnectorAccountCard({
  account,
  isDefault = account.isDefault === true,
  selected = false,
  saving = false,
  testBusy = false,
  refreshBusy = false,
  onSelect,
  onUpdate,
  onTest,
  onRefresh,
  onDelete,
  onMakeDefault,
  declaredCapabilities,
  onGrantCapability,
  grantBusyCapabilityId = null,
  onReconnect,
  reconnectBusy = false,
}: ConnectorAccountCardProps) {
  const { t } = useTranslation();
  const deleteModal = useModalState();
  const deleteBusy = deleteModal.state.status === "submitting";
  const confirmingDelete = deleteModal.state.status !== "closed";
  const [defaultBusy, setDefaultBusy] = useState(false);
  const status = deriveStatus(account.status, t);
  const statusPresentation = presentConnectorAccountStatus(account.status);
  const capabilityAccess = readConnectorAccountCapabilityAccess(account);
  const capabilityChips =
    declaredCapabilities && declaredCapabilities.length > 0
      ? presentConnectorCapabilityChips(capabilityAccess, declaredCapabilities)
      : undefined;
  const showReconnect =
    statusPresentation.needsReconnect && Boolean(onReconnect);
  const displayHandle = account.handle ?? account.externalId ?? null;
  const enabled = account.enabled !== false;

  const handleDelete = () => {
    void deleteModal.submit(() => Promise.resolve(onDelete()));
  };

  const handleMakeDefault = useCallback(async () => {
    setDefaultBusy(true);
    try {
      await onMakeDefault();
    } finally {
      setDefaultBusy(false);
    }
  }, [onMakeDefault]);

  return (
    <Card
      border={selected ? "strong" : "subtle"}
      flow="column"
      gap="default"
      padding="default"
      surface={selected ? "raised" : enabled ? "card" : "backgroundSubtle"}
      className="transition-opacity"
    >
      <div className="flex flex-wrap items-start gap-3">
        <Card
          variant="connectorAvatar"
          className="flex size-9 shrink-0 items-center justify-center"
        >
          {account.avatarUrl ? (
            <img
              src={account.avatarUrl}
              alt=""
              width={36}
              height={36}
              className="h-full w-full object-cover"
            />
          ) : (
            initials(account.label)
          )}
        </Card>

        <div className="min-w-[180px] flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <StatusBadge
              label={status.label}
              tone={statusPresentation.tone}
              withDot
            />
            <EditableAccountLabel
              value={account.label}
              disabled={saving}
              onSubmit={(label) => onUpdate({ label })}
              inputAriaLabel={t("connectoraccount.labelAria", {
                defaultValue: "Connector account label",
              })}
            />
            {isDefault ? (
              <Badge variant="outline" size="compact" className="shrink-0">
                {t("connectoraccount.default", { defaultValue: "Default" })}
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
            {displayHandle ? (
              <span className="max-w-[220px] truncate">{displayHandle}</span>
            ) : null}
            <span>{formatRelativeTime(account.lastSyncedAt, t)}</span>
            {account.statusDetail ? (
              <span className="max-w-[260px] truncate text-warn">
                {account.statusDetail}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {onSelect ? (
            <Button
              type="button"
              variant={selected ? "default" : "outline"}
              size="sm"
              disabled={saving || selected}
              onClick={onSelect}
            >
              {selected
                ? t("connectoraccount.selected", { defaultValue: "Selected" })
                : t("connectoraccount.use", { defaultValue: "Use" })}
            </Button>
          ) : null}
          {showReconnect ? (
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={saving || reconnectBusy}
              onClick={() => onReconnect?.()}
              aria-label={t("connectoraccount.reconnect", {
                defaultValue: "Reconnect account",
              })}
            >
              {reconnectBusy ? (
                <Spinner className="size-3" />
              ) : (
                <KeyRound className="size-3.5" aria-hidden />
              )}
              {t("connectoraccount.reconnectLabel", {
                defaultValue: "Reconnect",
              })}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={saving || isDefault || defaultBusy}
            onClick={() => void handleMakeDefault()}
            aria-label={t("connectoraccount.makeDefault", {
              defaultValue: "Make default account",
            })}
            title={t("connectoraccount.makeDefault", {
              defaultValue: "Make default account",
            })}
          >
            {defaultBusy ? (
              <Spinner className="size-3" />
            ) : (
              <Star className="size-3.5" aria-hidden />
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving || testBusy}
            onClick={() => void onTest()}
            aria-label={t("connectoraccount.test", {
              defaultValue: "Test connector account",
            })}
          >
            {testBusy ? (
              <Spinner className="size-3" />
            ) : (
              t("connectoraccount.test", { defaultValue: "Test" })
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={saving || refreshBusy}
            onClick={() => void onRefresh()}
            aria-label={t("connectoraccount.refresh", {
              defaultValue: "Refresh connector account",
            })}
            title={t("connectoraccount.refresh", {
              defaultValue: "Refresh connector account",
            })}
          >
            {refreshBusy ? (
              <Spinner className="size-3" />
            ) : (
              <RefreshCw className="size-3.5" aria-hidden />
            )}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="icon-sm"
            disabled={saving}
            onClick={deleteModal.open}
            aria-label={t("connectoraccount.delete", {
              defaultValue: "Delete connector account",
            })}
            title={t("connectoraccount.delete", {
              defaultValue: "Delete connector account",
            })}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      {capabilityChips !== undefined ? (
        <ConnectedCapabilityChips
          chips={capabilityChips}
          grantBusyCapabilityId={grantBusyCapabilityId}
          onGrantCapability={onGrantCapability}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <ConnectorAccountPurposeSelector
          value={account.role}
          disabled={saving}
          accountLabel={account.label}
          onChange={(role, confirmation) => {
            void onUpdate({ role, confirmation });
          }}
        />
        <ConnectorAccountPrivacySelector
          value={account.privacy}
          disabled={saving}
          accountLabel={account.label}
          onChange={(privacy, confirmation) =>
            onUpdate({ privacy, confirmation })
          }
        />
        <div className="inline-flex items-center gap-1.5 text-xs text-muted">
          <Checkbox
            checked={enabled}
            disabled={saving}
            onCheckedChange={(checked) => {
              void onUpdate({ enabled: checked === true });
            }}
            aria-label={t("connectoraccount.enabledAria", {
              defaultValue: "Connector account enabled",
            })}
          />
          <span>
            {t("connectoraccount.enabled", { defaultValue: "Enabled" })}
          </span>
        </div>
      </div>

      <Dialog
        open={confirmingDelete}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) deleteModal.close();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("connectoraccount.removeDialog.title", {
                defaultValue: "Remove this connector account?",
              })}
            </DialogTitle>
            <DialogDescription>
              {t("connectoraccount.removeDialog.description", {
                defaultValue:
                  "Removing the account deletes its connector metadata and may revoke stored auth state once backend support is enabled. This cannot be undone.",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={deleteBusy}
              onClick={deleteModal.close}
            >
              {t("connectoraccount.removeDialog.cancel", {
                defaultValue: "Cancel",
              })}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteBusy}
              onClick={handleDelete}
            >
              {deleteBusy ? (
                <Spinner className="size-3" />
              ) : (
                t("connectoraccount.removeDialog.confirm", {
                  defaultValue: "Remove account",
                })
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
