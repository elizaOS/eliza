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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  CalendarClock,
  Copy,
  MoreHorizontal,
  RefreshCw,
  ShieldOff,
  Trash2,
} from "lucide-react";

import type { ApiKeyDisplay } from "./types";
import { BrandButton } from "@/components/brand";

interface ApiKeysTableProps {
  keys: ApiKeyDisplay[];
  onCopyKey?: (id: string) => void;
  onDisableKey?: (id: string) => void;
  onDeleteKey?: (id: string) => void;
  onRegenerateKey?: (id: string) => void;
}

function getStatusStyles(status: ApiKeyDisplay["status"]) {
  switch (status) {
    case "active":
      return {
        badge: "bg-emerald-500/20 text-emerald-400 border-emerald-500/40",
        label: "Active",
      } as const;
    case "expired":
      return {
        badge: "bg-amber-500/20 text-amber-300 border-amber-500/40",
        label: "Expired",
      } as const;
    case "inactive":
    default:
      return {
        badge: "bg-white/10 text-white/60 border-white/20",
        label: "Inactive",
      } as const;
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
    <div className="overflow-hidden rounded-none border border-white/10 bg-black/40">
      <div className="grid grid-cols-[minmax(240px,2fr)_minmax(120px,1fr)_minmax(120px,1fr)_minmax(160px,1fr)_80px] items-center bg-black/60 p-4 text-xs font-medium uppercase tracking-wide text-white/50">
        <span>Key</span>
        <span>Usage</span>
        <span>Security</span>
        <span>Timeline</span>
        <span className="text-right">Actions</span>
      </div>
      <div className="h-px bg-white/10" />
      <div className="divide-y divide-white/10">
        {keys.map((key) => {
          const status = getStatusStyles(key.status);
          return (
            <div
              key={key.id}
              className="grid grid-cols-[minmax(240px,2fr)_minmax(120px,1fr)_minmax(120px,1fr)_minmax(160px,1fr)_80px] items-stretch px-4 py-5 text-sm transition hover:bg-white/5"
            >
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-white">{key.name}</span>
                  <span
                    className={cn(
                      "border rounded-none px-2 py-0.5 text-xs font-bold uppercase tracking-wide",
                      status.badge,
                    )}
                  >
                    {status.label}
                  </span>
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

              <div className="flex flex-col gap-2">
                <span className="font-medium text-white">
                  {key.usageCount.toLocaleString()} requests
                </span>
                <p className="text-xs text-white/50">
                  Rate limit {key.rateLimit.toLocaleString()} / min
                </p>
              </div>

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
                  <p className="text-xs text-white/50">
                    No permissions configured
                  </p>
                )}
              </div>

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

              <div className="flex items-start justify-end">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <BrandButton
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                      <span className="sr-only">Open actions</span>
                    </BrandButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuLabel>Manage key</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => onCopyKey?.(key.id)}>
                      <Copy className="mr-2 h-4 w-4" />
                      Copy prefix
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
