/**
 * Apps table component displaying user's applications.
 * Styled to match dashboard app cards with agent card dropdown menu.
 */

"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  StatusBadge,
} from "@elizaos/cloud-ui";
import { formatDistanceToNow } from "date-fns";
import {
  Activity,
  Copy,
  ExternalLink,
  // Sparkles,
  Loader2,
  MoreHorizontal,
  Settings,
  Trash2,
  Users,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import type { AppDto as App } from "@/types/cloud-api";

interface AppsTableProps {
  apps: App[];
}

export function AppsTable({ apps }: AppsTableProps) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<App | null>(null);

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

  const handleDeleteClick = (app: App, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDeleteTarget(app);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeletingId(deleteTarget.id);
    setDeleteTarget(null);
    try {
      const response = await fetch(`/api/v1/apps/${deleteTarget.id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to delete app");
      }

      toast.success("App deleted successfully");
      window.location.reload();
    } catch (error) {
      console.error("Error deleting app:", error);
      toast.error("Failed to delete app", {
        description: error instanceof Error ? error.message : "Please try again",
      });
    } finally {
      setDeletingId(null);
    }
  };

  if (apps.length === 0) {
    return null;
  }

  return (
    <>
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
                    to={`/dashboard/apps/${app.id}`}
                    className="min-w-0 truncate text-sm font-medium text-white transition-colors hover:text-[#FF5800]"
                  >
                    {app.name}
                  </Link>
                  <StatusBadge
                    status={app.is_active ? "success" : "neutral"}
                    label={app.is_active ? "Active" : "Inactive"}
                    className="px-1.5 py-0 text-[10px]"
                  />
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
                    {/* <DropdownMenuItem
                    asChild
                    className="cursor-pointer text-[#FF5800] bg-[#FF5800]/10 hover:bg-[#FF5800]/20 focus:bg-[#FF5800]/20 focus:text-[#FF5800]"
                  >
                    <Link href={`/dashboard/apps/create?appId=${app.id}`}>
                      <Sparkles className="h-4 w-4 mr-2 text-[#FF5800]" />
                      Continue Building
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator /> */}
                    <DropdownMenuItem asChild className="cursor-pointer">
                      <Link to={`/dashboard/apps/${app.id}`}>
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
                        <a href={app.website_url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="h-4 w-4 mr-2" />
                          Visit Website
                        </a>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="cursor-pointer text-red-500 bg-red-500/10 hover:bg-red-500/20 focus:bg-red-500/20 focus:text-red-500"
                      onClick={(e) => handleDeleteClick(app, e)}
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
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="min-w-0 basis-full truncate text-white/50 sm:basis-auto">
                  {app.app_url}
                </span>
                <span className="hidden text-white/20 sm:inline">·</span>
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
                  {formatDistanceToNow(new Date(app.updated_at)).replace("about ", "")} ago
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Delete Confirmation */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete App</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete{" "}
              <span className="font-semibold text-white">"{deleteTarget?.name}"</span>? This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
