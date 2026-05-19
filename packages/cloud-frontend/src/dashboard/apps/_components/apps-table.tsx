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
  AppsListView,
} from "@elizaos/ui";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useT } from "@/providers/I18nProvider";
import type { App } from "../../../lib/data/apps";

interface AppsTableProps {
  apps: App[];
}

export function AppsTable({ apps }: AppsTableProps) {
  const t = useT();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<App | null>(null);

  const handleCopyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(
        t("cloud.apps.toast.urlCopied", {
          defaultValue: "URL copied to clipboard",
        }),
      );
    } catch {
      toast.error(
        t("cloud.apps.toast.urlCopyFailed", {
          defaultValue: "Failed to copy URL",
        }),
      );
    }
  };

  const handleDeleteClick = (app: App) => {
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
        throw new Error(
          error.error ||
            t("cloud.apps.toast.deleteFailed", {
              defaultValue: "Failed to delete app",
            }),
        );
      }

      toast.success(
        t("cloud.apps.toast.deleteSuccess", {
          defaultValue: "App deleted successfully",
        }),
      );
      window.location.reload();
    } catch (error) {
      toast.error(
        t("cloud.apps.toast.deleteFailed", {
          defaultValue: "Failed to delete app",
        }),
        {
          description:
            error instanceof Error
              ? error.message
              : t("cloud.apps.toast.tryAgain", {
                  defaultValue: "Please try again",
                }),
        },
      );
    } finally {
      setDeletingId(null);
    }
  };

  if (apps.length === 0) {
    return null;
  }

  return (
    <>
      <AppsListView
        apps={apps}
        deletingId={deletingId}
        renderAppLink={({ app, className, children }) => (
          <Link to={`/dashboard/apps/${app.id}`} className={className}>
            {children}
          </Link>
        )}
        onCopyUrl={(app) => void handleCopyUrl(app.app_url)}
        onDeleteApp={(app) => handleDeleteClick(app as App)}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("cloud.apps.deleteDialog.title", {
                defaultValue: "Delete App",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("cloud.apps.deleteDialog.confirmPrefix", {
                defaultValue: "Are you sure you want to delete",
              })}{" "}
              <span className="font-semibold text-white">
                "{deleteTarget?.name}"
              </span>
              ?{" "}
              {t("cloud.apps.deleteDialog.cannotBeUndone", {
                defaultValue: "This action cannot be undone.",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("cloud.apps.deleteDialog.cancel", { defaultValue: "Cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              {t("cloud.apps.deleteDialog.delete", { defaultValue: "Delete" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
