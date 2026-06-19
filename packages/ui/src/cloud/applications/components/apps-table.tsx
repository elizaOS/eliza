/**
 * Applications list table. Reuses the shared `AppsListView` from cloud-ui and
 * adds the delete-confirmation dialog. Ported from
 * `@elizaos/cloud-frontend/src/dashboard/apps/_components/apps-table.tsx`; the
 * raw `fetch(... DELETE)` + `window.location.reload()` is replaced with the
 * typed `deleteApp()` mutation + a react-query invalidation so the list updates
 * in place under the app shell's Bearer-auth client.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { AppsListView } from "../../../cloud-ui/components/data-list";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { APPS_QUERY_KEY, type App, deleteApp } from "../lib/apps";

interface AppsTableProps {
  apps: App[];
}

export function AppsTable({ apps }: AppsTableProps) {
  const t = useCloudT();
  const queryClient = useQueryClient();
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

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeletingId(deleteTarget.id);
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      await deleteApp(target.id);
      toast.success(
        t("cloud.apps.toast.deleteSuccess", {
          defaultValue: "App deleted successfully",
        }),
      );
      await queryClient.invalidateQueries({ queryKey: APPS_QUERY_KEY });
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
        onDeleteApp={(app) => setDeleteTarget(app as App)}
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
