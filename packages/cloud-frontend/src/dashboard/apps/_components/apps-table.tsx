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
  DashboardDataList,
  ListActionMenu,
  StatusBadge,
} from "@elizaos/ui";
import { formatDistanceToNow } from "date-fns";
import {
  Activity,
  Copy,
  ExternalLink,
  Loader2,
  Settings,
  Trash2,
  Users,
} from "lucide-react";
import { type MouseEvent, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import type { App } from "../../../lib/data/apps";

interface AppsTableProps {
  apps: App[];
}

export function AppsTable({ apps }: AppsTableProps) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<App | null>(null);

  const handleCopyUrl = async (url: string, e?: MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    try {
      await navigator.clipboard.writeText(url);
      toast.success("URL copied to clipboard");
    } catch {
      toast.error("Failed to copy URL");
    }
  };

  const handleDeleteClick = (app: App, e?: MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
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
    <>
      <DashboardDataList className="grid grid-cols-1 gap-2 space-y-0">
        {apps.map((app) => (
          <div
            key={app.id}
            className="group relative overflow-hidden rounded-sm bg-white/5 border border-white/10 transition-all duration-300 hover:border-white/20 hover:bg-white/[0.07] min-w-0"
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

                <ListActionMenu
                  triggerClassName="h-8 w-8 rounded-lg bg-transparent hover:bg-white/10"
                  contentClassName="w-44"
                  onTriggerClick={(e) => e.preventDefault()}
                  items={[
                    {
                      asChild: true,
                      label: "Manage App",
                      className: "cursor-pointer",
                      child: (
                        <Link to={`/dashboard/apps/${app.id}`}>
                          <Settings className="mr-2 h-4 w-4" />
                          Manage App
                        </Link>
                      ),
                    },
                    {
                      label: "Copy URL",
                      icon: Copy,
                      className: "cursor-pointer",
                      onSelect: () => handleCopyUrl(app.app_url),
                    },
                    ...(app.website_url
                      ? [
                          {
                            asChild: true as const,
                            label: "Visit Website",
                            className: "cursor-pointer",
                            child: (
                              <a
                                href={app.website_url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                <ExternalLink className="mr-2 h-4 w-4" />
                                Visit Website
                              </a>
                            ),
                          },
                        ]
                      : []),
                    { type: "separator" },
                    {
                      label: "Delete App",
                      icon: deletingId === app.id ? Loader2 : Trash2,
                      disabled: deletingId === app.id,
                      className:
                        "cursor-pointer bg-red-500/10 text-red-500 hover:bg-red-500/20 focus:bg-red-500/20 focus:text-red-500 [&_svg]:text-red-500 data-[disabled]:opacity-60",
                      onSelect: () => handleDeleteClick(app),
                    },
                  ]}
                />
              </div>

              {/* Stats & URL */}
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="min-w-0 basis-full truncate text-white/74 sm:basis-auto">
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
      </DashboardDataList>

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
              <span className="font-semibold text-white">
                "{deleteTarget?.name}"
              </span>
              ? This action cannot be undone.
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
