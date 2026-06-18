import {
  CalendarClock,
  Copy,
  RefreshCw,
  ShieldOff,
  Trash2,
} from "lucide-react";
import { StatusBadge } from "../../../components/ui/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table";
import { BrandButton } from "../brand/brand-button";
import {
  DashboardDataListDesktop,
  DashboardDataListMobile,
} from "./dashboard-data-list";
import { ListActionMenu } from "./list-action-menu";

export type ApiKeyStatus = "active" | "inactive" | "expired";

export interface ApiKeyDisplay {
  id: string;
  name: string;
  description?: string | null;
  keyPrefix: string;
  status: ApiKeyStatus;
  lastUsedAt?: string | null;
  createdAt: string;
  usageCount: number;
  rateLimit: number;
  expiresAt?: string | null;
}

export interface ApiKeysTableProps {
  keys: ApiKeyDisplay[];
  onCopyKey?: (id: string) => void;
  onDisableKey?: (id: string) => void;
  onDeleteKey?: (id: string) => void;
  onRegenerateKey?: (id: string) => void;
}

function getStatusVariant(
  status: ApiKeyDisplay["status"],
): "success" | "warning" | "neutral" {
  switch (status) {
    case "active":
      return "success";
    case "expired":
      return "warning";
    default:
      return "neutral";
  }
}

function getStatusLabel(status: ApiKeyDisplay["status"]): string {
  switch (status) {
    case "active":
      return "Active";
    case "expired":
      return "Expired";
    default:
      return "Inactive";
  }
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function renderActions(
  key: ApiKeyDisplay,
  handlers: Pick<
    ApiKeysTableProps,
    "onCopyKey" | "onDisableKey" | "onDeleteKey" | "onRegenerateKey"
  >,
  triggerClassName?: string,
) {
  return (
    <ListActionMenu
      label="Manage key"
      triggerClassName={triggerClassName}
      items={[
        {
          label: "Copy key",
          icon: Copy,
          onSelect: () => handlers.onCopyKey?.(key.id),
        },
        {
          label: "Regenerate key",
          icon: RefreshCw,
          onSelect: () => handlers.onRegenerateKey?.(key.id),
        },
        { type: "separator" },
        {
          label: key.status === "active" ? "Disable key" : "Enable key",
          icon: ShieldOff,
          onSelect: () => handlers.onDisableKey?.(key.id),
        },
        {
          label: "Delete key",
          icon: Trash2,
          destructive: true,
          onSelect: () => handlers.onDeleteKey?.(key.id),
        },
      ]}
    />
  );
}

export function ApiKeysTable({
  keys,
  onCopyKey,
  onDisableKey,
  onDeleteKey,
  onRegenerateKey,
}: ApiKeysTableProps) {
  if (keys.length === 0) {
    return null;
  }

  const handlers = {
    onCopyKey,
    onDisableKey,
    onDeleteKey,
    onRegenerateKey,
  };

  return (
    <>
      <DashboardDataListMobile className="space-y-3">
        {keys.map((key) => (
          <div
            key={key.id}
            className="space-y-3 rounded-sm border border-white/10 bg-black/40 p-4"
          >
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-semibold text-white">
                    {key.name}
                  </span>
                  <StatusBadge
                    status={getStatusVariant(key.status)}
                    label={getStatusLabel(key.status)}
                  />
                </div>
                {key.description ? (
                  <p className="line-clamp-2 text-xs text-white/60">
                    {key.description}
                  </p>
                ) : null}
              </div>
              {renderActions(key, handlers)}
            </div>

            <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-white/60">
              <span className="rounded-sm border border-white/10 bg-black/60 px-1.5 py-0.5 font-mono text-xs text-white">
                {`${key.keyPrefix}.......`}
              </span>
              <BrandButton
                variant="ghost"
                size="sm"
                className="h-8 px-2"
                onClick={() => onCopyKey?.(key.id)}
              >
                <Copy className="mr-1 h-3.5 w-3.5" />
                Copy
              </BrandButton>
              <BrandButton
                variant="ghost"
                size="sm"
                className="h-8 px-2"
                onClick={() => onRegenerateKey?.(key.id)}
              >
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
                Regenerate
              </BrandButton>
            </div>

            <div className="grid grid-cols-2 gap-3 border-t border-white/10 pt-3 text-xs">
              <div>
                <p className="text-white/40">Usage</p>
                <p className="mt-1 font-medium text-white">
                  {key.usageCount.toLocaleString()} requests
                </p>
                <p className="mt-0.5 text-white/74">
                  {key.rateLimit.toLocaleString()} / min
                </p>
              </div>
              <div>
                <p className="text-white/40">Timeline</p>
                <p className="mt-1 text-white/60">
                  Created {formatDate(key.createdAt)}
                </p>
                <p className="mt-0.5 text-white/60">
                  Last used {formatDate(key.lastUsedAt)}
                </p>
              </div>
            </div>
          </div>
        ))}
      </DashboardDataListMobile>

      <DashboardDataListDesktop className="border-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Usage</TableHead>
              <TableHead>Timeline</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((key) => (
              <TableRow key={key.id}>
                <TableCell>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white">
                        {key.name}
                      </span>
                      <StatusBadge
                        status={getStatusVariant(key.status)}
                        label={getStatusLabel(key.status)}
                      />
                    </div>
                    {key.description ? (
                      <p className="text-xs text-white/60">{key.description}</p>
                    ) : null}
                    <div className="flex items-center gap-2 text-xs text-white/60">
                      <span className="rounded-sm border border-white/10 bg-black/60 px-1.5 py-0.5 font-mono text-xs text-white">
                        {`${key.keyPrefix}.......`}
                      </span>
                      <BrandButton
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2"
                        onClick={() => onCopyKey?.(key.id)}
                      >
                        <Copy className="mr-1 h-3.5 w-3.5" />
                        Copy
                      </BrandButton>
                      <BrandButton
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2"
                        onClick={() => onRegenerateKey?.(key.id)}
                      >
                        <RefreshCw className="mr-1 h-3.5 w-3.5" />
                        Regenerate
                      </BrandButton>
                    </div>
                  </div>
                </TableCell>

                <TableCell>
                  <div className="flex flex-col gap-2">
                    <span className="font-medium text-white">
                      {key.usageCount.toLocaleString()} requests
                    </span>
                    <p className="text-xs text-white/74">
                      Rate limit {key.rateLimit.toLocaleString()} / min
                    </p>
                  </div>
                </TableCell>

                <TableCell>
                  <div className="flex flex-col gap-2 text-xs text-white/60">
                    <div className="flex items-center gap-2">
                      <CalendarClock className="h-3.5 w-3.5 text-[#FF5800]" />
                      <span>Created {formatDate(key.createdAt)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <CalendarClock className="h-3.5 w-3.5 text-[#FF5800]" />
                      <span>Last used {formatDate(key.lastUsedAt)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <CalendarClock className="h-3.5 w-3.5 text-[#FF5800]" />
                      <span>
                        {key.expiresAt
                          ? `Expires ${formatDate(key.expiresAt)}`
                          : "No expiry"}
                      </span>
                    </div>
                  </div>
                </TableCell>

                <TableCell className="text-right">
                  {renderActions(key, handlers, "h-9 w-9")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DashboardDataListDesktop>
    </>
  );
}
