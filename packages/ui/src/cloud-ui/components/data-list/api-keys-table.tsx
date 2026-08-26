/**
 * Minimal API-keys table: Name · Key · Created · Last used · Revoke. The key
 * cell shows only the public prefix (the secret is one-time, reveal-on-create
 * only), a status badge appears only when a key is NOT active, and the sole
 * row action is a ghost destructive "Revoke". Mobile renders one compact card
 * per key instead of the table.
 */

import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { StatusBadge } from "../../../components/ui/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table";
import {
  DashboardDataListDesktop,
  DashboardDataListMobile,
} from "./dashboard-data-list";

export type ApiKeyStatus = "active" | "inactive" | "expired";

export interface ApiKeyDisplay {
  id: string;
  name: string;
  keyPrefix: string;
  status: ApiKeyStatus;
  createdAt: string;
  lastUsedAt?: string | null;
}

export interface ApiKeysTableProps {
  keys: ApiKeyDisplay[];
  onRevokeKey?: (id: string) => void;
}

/** Short "Jan 12, 2026"-style date; explicit locale keeps renders deterministic. */
export function formatApiKeyDate(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// Status badge only for non-active keys: an all-"Active" column is noise.
function statusBadge(status: ApiKeyStatus) {
  if (status === "active") return null;
  return (
    <StatusBadge
      status={status === "expired" ? "warning" : "neutral"}
      label={status === "expired" ? "Expired" : "Inactive"}
    />
  );
}

function keyPrefixChip(keyPrefix: string) {
  return (
    <Badge asChild variant="adminMono">
      <span className="text-xs">{`${keyPrefix}…`}</span>
    </Badge>
  );
}

function revokeButton(id: string, onRevokeKey?: (id: string) => void) {
  return (
    <Button variant="dangerGhost" size="sm" onClick={() => onRevokeKey?.(id)}>
      Revoke
    </Button>
  );
}

export function ApiKeysTable({ keys, onRevokeKey }: ApiKeysTableProps) {
  if (keys.length === 0) {
    return null;
  }

  return (
    <>
      <DashboardDataListMobile className="space-y-3">
        {keys.map((key) => (
          <Card key={key.id} variant="outlinedPadded">
            <div className="space-y-2">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium text-txt-strong">
                    {key.name}
                  </span>
                  {statusBadge(key.status)}
                </div>
                {revokeButton(key.id, onRevokeKey)}
              </div>
              <div>{keyPrefixChip(key.keyPrefix)}</div>
              <p className="text-xs text-muted">
                Created {formatApiKeyDate(key.createdAt)} · Last used{" "}
                {key.lastUsedAt ? formatApiKeyDate(key.lastUsedAt) : "Never"}
              </p>
            </div>
          </Card>
        ))}
      </DashboardDataListMobile>

      <DashboardDataListDesktop variant="borderless">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((key) => (
              <TableRow key={key.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-txt-strong">
                      {key.name}
                    </span>
                    {statusBadge(key.status)}
                  </div>
                </TableCell>
                <TableCell>{keyPrefixChip(key.keyPrefix)}</TableCell>
                <TableCell className="text-sm text-muted">
                  {formatApiKeyDate(key.createdAt)}
                </TableCell>
                <TableCell className="text-sm text-muted">
                  {key.lastUsedAt ? formatApiKeyDate(key.lastUsedAt) : "Never"}
                </TableCell>
                <TableCell className="text-right">
                  {revokeButton(key.id, onRevokeKey)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DashboardDataListDesktop>
    </>
  );
}
