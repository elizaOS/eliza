/**
 * Apps table component displaying user's applications.
 * Styled to match dashboard app cards with agent card dropdown menu.
 */

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App } from "@/db/schemas";
import {
  Activity,
  Users,
  MoreHorizontal,
  Settings,
  Trash2,
  Copy,
  Sparkles,
  Loader2,
  ExternalLink,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

interface AppsTableProps {
  apps: App[];
}

export function AppsTable({ apps }: AppsTableProps) {
  const router = useRouter();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleCopyUrl = async (url: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(url);
      toast.success("URL copied to clipboard");
    } catch {
      toast.error("Failed to copy URL");
    }
  };

  const handleDelete = async (app: App, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (
      !confirm(
        `Are you sure you want to delete "${app.name}"? This action cannot be undone.`,
      )
    ) {
      return;
    }

    setDeletingId(app.id);
    try {
      const response = await fetch(`/api/v1/apps/${app.id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to delete app");
      }

      toast.success("App deleted successfully");
      router.refresh();
    } catch (error) {
      console.error("Error deleting app:", error);
      toast.error("Failed to delete app", {
        description:
          error instanceof Error ? error.message : "Please try again",
      });
    } finally {
      setDeletingId(null);
    }
  };

  if (apps.length === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 gap-2">
      {apps.map((app) => (
        <div
          key={app.id}
          className="group relative overflow-hidden rounded-xl bg-white/5 border border-white/10 transition-all duration-300 hover:border-white/20 hover:bg-white/[0.07] min-w-0"
        >
          {/* Header */}
          <div className="px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <Link
                  href={`/dashboard/apps/${app.id}`}
                  className="text-sm font-medium text-white truncate hover:text-[#FF5800] transition-colors"
                >
                  {app.name}
                </Link>
                <Badge
                  className={
                    app.is_active
                      ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[10px] px-1.5 py-0 shrink-0"
                      : "bg-zinc-500/20 text-zinc-400 border-zinc-500/30 text-[10px] px-1.5 py-0 shrink-0"
                  }
                >
                  {app.is_active ? "Active" : "Inactive"}
                </Badge>
                {app.affiliate_code && (
                  <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30 text-[10px] px-1.5 py-0 shrink-0">
                    Affiliate
                  </Badge>
                )}
              </div>

              {/* Dropdown Menu */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="flex-shrink-0 flex items-center justify-center h-8 w-8 rounded-lg bg-transparent hover:bg-white/10 transition-colors"
                  onClick={(e) => e.preventDefault()}
                >
                  <MoreHorizontal className="h-4 w-4 text-white/60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem
                    asChild
                    className="cursor-pointer text-[#FF5800] bg-[#FF5800]/10 hover:bg-[#FF5800]/20 focus:bg-[#FF5800]/20 focus:text-[#FF5800]"
                  >
                    <Link href={`/dashboard/apps/create?appId=${app.id}`}>
                      <Sparkles className="h-4 w-4 mr-2 text-[#FF5800]" />
                      Continue Building
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild className="cursor-pointer">
                    <Link href={`/dashboard/apps/${app.id}`}>
                      <Settings className="h-4 w-4 mr-2" />
                      Manage App
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="cursor-pointer"
                    onClick={(e) => handleCopyUrl(app.app_url, e)}
                  >
                    <Copy className="h-4 w-4 mr-2" />
                    Copy URL
                  </DropdownMenuItem>
                  {app.website_url && (
                    <DropdownMenuItem asChild className="cursor-pointer">
                      <a
                        href={app.website_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ExternalLink className="h-4 w-4 mr-2" />
                        Visit Website
                      </a>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="cursor-pointer text-red-500 bg-red-500/10 hover:bg-red-500/20 focus:bg-red-500/20 focus:text-red-500"
                    onClick={(e) => handleDelete(app, e)}
                    disabled={deletingId === app.id}
                  >
                    {deletingId === app.id ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin text-red-500" />
                    ) : (
                      <Trash2 className="h-4 w-4 mr-2 text-red-500" />
                    )}
                    Delete App
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Stats & URL */}
            <div className="flex items-center gap-3 mt-1 text-xs">
              <span className="text-white/50 truncate">{app.app_url}</span>
              <span className="text-white/20">·</span>
              <div className="flex items-center gap-1 text-white/50 shrink-0">
                <Users className="h-3 w-3 text-blue-400" />
                <span>{app.total_users.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-1 text-white/50 shrink-0">
                <Activity className="h-3 w-3 text-purple-400" />
                <span>{app.total_requests.toLocaleString()}</span>
              </div>
              <span className="text-white/20">·</span>
              <span className="text-white/40 shrink-0">
                {formatDistanceToNow(new Date(app.updated_at)).replace(
                  "about ",
                  "",
                )}{" "}
                ago
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
