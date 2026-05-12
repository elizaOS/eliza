import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { cn } from "../../lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { StatusBadge } from "../ui/status-badge";
import { RefreshCw, Star, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import type {
  ConnectorAccountRecord,
  ConnectorAccountStatus,
  ConnectorAccountUpdateInput,
} from "../../api/client-agent";
import { useModalState } from "../../hooks/useModalState";
import { EditableAccountLabel } from "../accounts/EditableAccountLabel";
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
}

interface StatusInfo {
  label: string;
  tone: "success" | "warning" | "danger" | "muted";
}

function formatRelativeTime(epochMs: number | undefined): string {
  if (!epochMs) return "Never synced";
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return "Synced just now";
  if (diff < 3_600_000) return `Synced ${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `Synced ${Math.floor(diff / 3_600_000)}h ago`;
  return `Synced ${Math.floor(diff / 86_400_000)}d ago`;
}

function deriveStatus(status: ConnectorAccountStatus | undefined): StatusInfo {
  switch (status) {
    case "connected":
      return { label: "Connected", tone: "success" };
    case "pending":
      return { label: "Pending", tone: "warning" };
    case "needs-reauth":
      return { label: "Needs reauth", tone: "danger" };
    case "error":
      return { label: "Error", tone: "danger" };
    case "disconnected":
      return { label: "Disconnected", tone: "muted" };
    default:
      return { label: "Unknown", tone: "muted" };
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
}: ConnectorAccountCardProps) {
  const deleteModal = useModalState();
  const deleteBusy = deleteModal.state.status === "submitting";
  const confirmingDelete = deleteModal.state.status !== "closed";
  const [defaultBusy, setDefaultBusy] = useState(false);
  const status = deriveStatus(account.status);
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
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border/45 bg-card/35 px-3 py-3 transition-opacity",
        !enabled && "opacity-60",
        selected && "border-accent/70 bg-accent/5",
      )}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/50 bg-bg-accent text-xs font-semibold text-muted">
          {account.avatarUrl ? (
            <img
              src={account.avatarUrl}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            initials(account.label)
          )}
        </div>

        <div className="min-w-[180px] flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <StatusBadge label={status.label} tone={status.tone} withDot />
            <EditableAccountLabel
              value={account.label}
              disabled={saving}
              onSubmit={(label) => onUpdate({ label })}
              inputAriaLabel="Connector account label"
            />
            {isDefault ? (
              <Badge variant="outline" className="shrink-0 text-[10px]">
                Default
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
            {displayHandle ? (
              <span className="max-w-[220px] truncate">{displayHandle}</span>
            ) : null}
            <span>{formatRelativeTime(account.lastSyncedAt)}</span>
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
              className="h-7 px-2 text-xs"
            >
              {selected ? "Selected" : "Use"}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving || isDefault || defaultBusy}
            onClick={() => void handleMakeDefault()}
            aria-label="Make default account"
            title="Make default account"
            className="h-7 w-7 p-0"
          >
            {defaultBusy ? (
              <Spinner className="h-3 w-3" />
            ) : (
              <Star className="h-3.5 w-3.5" aria-hidden />
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving || testBusy}
            onClick={() => void onTest()}
            className="h-7 px-2 text-xs"
          >
            {testBusy ? <Spinner className="h-3 w-3" /> : "Test"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving || refreshBusy}
            onClick={() => void onRefresh()}
            aria-label="Refresh connector account"
            title="Refresh connector account"
            className="h-7 w-7 p-0"
          >
            {refreshBusy ? (
              <Spinner className="h-3 w-3" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={deleteModal.open}
            aria-label="Delete connector account"
            title="Delete connector account"
            className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      </div>

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
            aria-label="Connector account enabled"
          />
          <span>Enabled</span>
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
            <DialogTitle>Remove this connector account?</DialogTitle>
            <DialogDescription>
              Removing the account deletes its connector metadata and may revoke
              stored auth state once backend support is enabled. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={deleteBusy}
              onClick={deleteModal.close}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteBusy}
              onClick={handleDelete}
            >
              {deleteBusy ? <Spinner className="h-3 w-3" /> : "Remove account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
