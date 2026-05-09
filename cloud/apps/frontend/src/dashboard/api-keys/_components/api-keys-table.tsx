/**
 * API keys table component displaying API keys with status, expiration, and actions.
 * Supports copying, disabling, deleting, and regenerating keys.
 *
 * @param props - API keys table configuration
 * @param props.keys - Array of API key display objects
 * @param props.onCopyKey - Callback when key is copied
 * @param props.onDisableKey - Callback when key is disabled
 * @param props.onDeleteKey - Callback when key is deleted
 * @param props.onRegenerateKey - Callback when key is regenerated
 */

import {
  BrandButton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@elizaos/cloud-ui";
import { CalendarClock, Copy, MoreHorizontal, RefreshCw, ShieldOff, Trash2 } from "lucide-react";

import type { ApiKeyDisplay } from "./types";

interface ApiKeysTableProps {
  keys: ApiKeyDisplay[];
  onCopyKey?: (id: string) => void;
  onDisableKey?: (id: string) => void;
  onDeleteKey?: (id: string) => void;
  onRegenerateKey?: (id: string) => void;
}

function getStatusVariant(status: ApiKeyDisplay["status"]): "success" | "warning" | "neutral" {
  switch (status) {
    case "active":
      return "success";
    case "expired":
      return "warning";
    case "inactive":
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
    case "inactive":
    default:
      return "Inactive";
  }
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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

  return (
    <>
      <div className="space-y-3 md:hidden">
        {keys.map((key) => (
          <div key={key.id} className="space-y-3 border border-white/10 bg-black/40 p-4">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-semibold text-white">{key.name}</span>
                  <StatusBadge
                    status={getStatusVariant(key.status)}
                    label={getStatusLabel(key.status)}
                  />
                </div>
                <p className="line-clamp-2 text-xs text-white/60">
                  {key.description ?? "No description provided"}
                </p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <BrandButton variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                    <MoreHorizontal className="h-4 w-4" />
                    <span className="sr-only">Open actions</span>
                  </BrandButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuLabel>Manage key</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onCopyKey?.(key.id)}>
                    <Copy className="mr-2 h-4 w-4" />
                    Copy key
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onRegenerateKey?.(key.id)}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Regenerate key
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onDisableKey?.(key.id)}>
                    <ShieldOff className="mr-2 h-4 w-4" />
                    {key.status === "active" ? "Disable key" : "Enable key"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => onDeleteKey?.(key.id)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete key
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-white/60">
              <span className="rounded-none border border-white/10 bg-black/60 px-1.5 py-0.5 font-mono text-xs text-white">
                {`${key.keyPrefix}•••••••`}
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
                <p className="mt-0.5 text-white/50">{key.rateLimit.toLocaleString()} / min</p>
              </div>
              <div>
                <p className="text-white/40">Timeline</p>
                <p className="mt-1 text-white/60">Created {formatDate(key.createdAt)}</p>
                <p className="mt-0.5 text-white/60">Last used {formatDate(key.lastUsedAt)}</p>
              </div>
            </div>

            <div className="border-t border-white/10 pt-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/50">
                Permissions
              </p>
              {key.permissions.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {key.permissions.map((permission) => (
                    <span
                      key={permission}
                      className="rounded-none bg-white/10 px-2 py-0.5 text-xs text-white/70"
                    >
                      {permission}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-white/50">No permissions configured</p>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Usage</TableHead>
              <TableHead>Security</TableHead>
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
                      <span className="font-semibold text-white">{key.name}</span>
                      <StatusBadge
                        status={getStatusVariant(key.status)}
                        label={getStatusLabel(key.status)}
                      />
                    </div>
                    <p className="text-xs text-white/60">
                      {key.description ?? "No description provided"}
                    </p>
                    <div className="flex items-center gap-2 text-xs text-white/60">
                      <span className="rounded-none bg-black/60 border border-white/10 px-1.5 py-0.5 font-mono text-xs text-white">
                        {`${key.keyPrefix}•••••••`}
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
                    <p className="text-xs text-white/50">
                      Rate limit {key.rateLimit.toLocaleString()} / min
                    </p>
                  </div>
                </TableCell>

                <TableCell>
                  <div className="flex flex-col gap-2">
                    <span className="text-xs font-medium text-white/50 uppercase tracking-wide">
                      Permissions
                    </span>
                    {key.permissions.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {key.permissions.map((permission) => (
                          <span
                            key={permission}
                            className="rounded-none bg-white/10 px-2 py-0.5 text-xs text-white/70"
                          >
                            {permission}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-white/50">No permissions configured</p>
                    )}
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
                        {key.expiresAt ? `Expires ${formatDate(key.expiresAt)}` : "No expiry"}
                      </span>
                    </div>
                  </div>
                </TableCell>

                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <BrandButton variant="ghost" size="icon" className="h-9 w-9">
                        <MoreHorizontal className="h-4 w-4" />
                        <span className="sr-only">Open actions</span>
                      </BrandButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuLabel>Manage key</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => onCopyKey?.(key.id)}>
                        <Copy className="mr-2 h-4 w-4" />
                        Copy key
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onRegenerateKey?.(key.id)}>
                        <RefreshCw className="mr-2 h-4 w-4" />
                        Regenerate key
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => onDisableKey?.(key.id)}>
                        <ShieldOff className="mr-2 h-4 w-4" />
                        {key.status === "active" ? "Disable key" : "Enable key"}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => onDeleteKey?.(key.id)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete key
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
