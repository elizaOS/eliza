/**
 * Applications list table. Reuses the shared `AppsListView` from cloud-ui and
 * adds row selection, a bulk-delete bar, and the delete-confirmation dialog
 * (one dialog serves the row action and the bulk bar).
 *
 * Deletes are optimistic against the react-query cache: the apps list API is
 * eventually consistent, so an invalidate-and-refetch right after DELETE can
 * still return the deleted app and resurrect its row. Deleted ids are removed
 * from the cache directly; a delayed invalidation reconciles with the server
 * after the lag window.
 */

import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
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
import { Button } from "../../../components/ui/button";
import { copyTextToClipboard } from "../../../utils/clipboard";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { APPS_QUERY_KEY, type App, deleteApp } from "../lib/apps";

/** How long to wait before re-syncing the list from the server after a
 * delete — long enough for the API's eventual consistency to settle. */
const POST_DELETE_RESYNC_MS = 8_000;

export function AppsTable({ apps }: { apps: App[] }) {
  const t = useCloudT();
  const queryClient = useQueryClient();
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [deleteTargets, setDeleteTargets] = useState<App[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const handleCopyUrl = async (url: string) => {
    try {
      await copyTextToClipboard(url);
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
    if (!deleteTargets || deleteTargets.length === 0) return;
    const targets = deleteTargets;
    const ids = targets.map((app) => app.id);
    setDeletingIds(new Set(ids));
    setDeleteTargets(null);
    try {
      const results = await Promise.allSettled(ids.map((id) => deleteApp(id)));
      const deletedIds = ids.filter(
        (_, i) => results[i].status === "fulfilled",
      );
      const failed = targets.filter((_, i) => results[i].status === "rejected");

      if (deletedIds.length > 0) {
        // Drop deleted rows from the cache directly — see the file header for
        // why an immediate invalidate would bring them back.
        queryClient.setQueryData<App[]>(APPS_QUERY_KEY, (prev) =>
          prev?.filter((app) => !deletedIds.includes(app.id)),
        );
        setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: APPS_QUERY_KEY });
        }, POST_DELETE_RESYNC_MS);
        toast.success(
          deletedIds.length === 1
            ? t("cloud.apps.toast.deleteSuccess", {
                defaultValue: "App deleted successfully",
              })
            : t("cloud.apps.toast.deleteManySuccess", {
                count: deletedIds.length,
                defaultValue: "{{count}} apps deleted",
              }),
        );
      }

      if (failed.length > 0) {
        const firstError = results.find(
          (r): r is PromiseRejectedResult => r.status === "rejected",
        )?.reason;
        toast.error(
          t("cloud.apps.toast.deleteSomeFailed", {
            count: failed.length,
            defaultValue: "Failed to delete {{count}} app(s)",
          }),
          {
            description:
              firstError instanceof Error
                ? firstError.message
                : t("cloud.apps.toast.tryAgain", {
                    defaultValue: "Please try again",
                  }),
          },
        );
      }
      setSelectedIds(new Set());
    } finally {
      setDeletingIds(new Set());
    }
  };

  if (apps.length === 0) {
    return null;
  }

  const dialogCount = deleteTargets?.length ?? 0;

  return (
    <>
      {selectedIds.size > 0 && (
        <div className="mb-2 flex items-center justify-between gap-3 rounded-sm border border-white/10 bg-white/5 px-3 py-2">
          <span className="text-sm text-white">
            {t("cloud.apps.selectedCount", {
              count: selectedIds.size,
              defaultValue: "{{count}} selected",
            })}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="h-8 px-3 text-white/62 hover:text-white"
            >
              {t("cloud.apps.clearSelection", { defaultValue: "Clear" })}
            </Button>
            <Button
              variant="ghost"
              type="button"
              disabled={deletingIds.size > 0}
              onClick={() =>
                setDeleteTargets(apps.filter((app) => selectedIds.has(app.id)))
              }
              className="h-8 px-3 text-red-400 hover:bg-red-500/10 hover:text-red-300"
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {t("cloud.apps.deleteSelected", {
                defaultValue: "Delete selected",
              })}
            </Button>
          </div>
        </div>
      )}

      <AppsListView
        apps={apps}
        deletingId={deletingIds.size === 1 ? [...deletingIds][0] : null}
        renderAppLink={({ app, className, children }) => (
          <Link to={`/dashboard/apps/${app.id}`} className={className}>
            {children}
          </Link>
        )}
        onCopyUrl={(app) => void handleCopyUrl(app.app_url)}
        onDeleteApp={(app) => setDeleteTargets([app as App])}
        onToggleSelect={(app, selected) =>
          setSelectedIds((prev) => {
            const next = new Set(prev);
            if (selected) next.add(app.id);
            else next.delete(app.id);
            return next;
          })
        }
        selectedIds={selectedIds}
      />

      <AlertDialog
        open={deleteTargets !== null}
        onOpenChange={(open) => !open && setDeleteTargets(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {dialogCount > 1
                ? t("cloud.apps.deleteDialog.titleMany", {
                    count: dialogCount,
                    defaultValue: "Delete {{count}} Apps",
                  })
                : t("cloud.apps.deleteDialog.title", {
                    defaultValue: "Delete App",
                  })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("cloud.apps.deleteDialog.confirmPrefix", {
                defaultValue: "Are you sure you want to delete",
              })}{" "}
              <span className="font-semibold text-white">
                {dialogCount > 1
                  ? t("cloud.apps.deleteDialog.manyApps", {
                      count: dialogCount,
                      defaultValue: "{{count}} apps",
                    })
                  : `"${deleteTargets?.[0]?.name}"`}
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
