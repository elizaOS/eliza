/**
 * Applications list table. Reuses the shared `AppsListView` from cloud-ui and
 * adds row selection, a bulk-delete bar, and the delete-confirmation dialog
 * (one dialog serves the row action and the bulk bar).
 *
 * One mounted authority owns one local batch. Pending snapshots survive list
 * refetches; the caller keys this owner by user/organization and supplies the
 * same authenticated query key as the list. Unmount retires delayed callbacks.
 *
 * Confirmed deletes are optimistic against the react-query cache: the apps list API is
 * eventually consistent, so an invalidate-and-refetch right after DELETE can
 * still return the deleted app and resurrect its row. Deleted ids are removed
 * from the cache directly; a delayed invalidation reconciles with the server
 * after the lag window.
 */

import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "../../../bridge/toast";
import {
  BulkDeleteDialog,
  BulkSelectionBar,
  runBulkDelete,
} from "../../../cloud-ui/components/bulk-select";
import { AppsListView } from "../../../cloud-ui/components/data-list/apps-list-view";
import { copyTextToClipboard } from "../../../utils/clipboard";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { type App, deleteApp } from "../lib/apps";

/** How long to wait before re-syncing the list from the server after a
 * delete — long enough for the API's eventual consistency to settle. */
const POST_DELETE_RESYNC_MS = 8_000;

export function AppsTable({
  apps,
  queryKey,
  children,
}: {
  apps: App[];
  queryKey: QueryKey;
  children?: ReactNode;
}) {
  const t = useCloudT();
  const queryClient = useQueryClient();
  const deletionInFlight = useRef(false);
  const admittedRows = useRef<App[]>([]);
  const mounted = useRef(true);
  const resyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (resyncTimer.current !== null) clearTimeout(resyncTimer.current);
    };
  }, []);
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
    if (
      deletionInFlight.current ||
      !deleteTargets ||
      deleteTargets.length === 0
    )
      return;
    deletionInFlight.current = true;
    const targets = deleteTargets;
    admittedRows.current = targets;
    const ids = targets.map((app) => app.id);
    setDeletingIds(new Set(ids));
    setDeleteTargets(null);
    try {
      const outcome = await runBulkDelete(targets, (app) => deleteApp(app.id));
      if (!mounted.current) return;
      const deletedIds = outcome.deleted.map((app) => app.id);
      const failed = outcome.failed;

      if (deletedIds.length > 0) {
        // Drop deleted rows from the cache directly — see the file header for
        // why an immediate invalidate would bring them back.
        queryClient.setQueryData<App[]>(queryKey, (prev) =>
          prev?.filter((app) => !deletedIds.includes(app.id)),
        );
        if (resyncTimer.current !== null) clearTimeout(resyncTimer.current);
        resyncTimer.current = setTimeout(() => {
          resyncTimer.current = null;
          if (mounted.current) void queryClient.invalidateQueries({ queryKey });
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
        const firstError = outcome.firstError;
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
      admittedRows.current = [];
      deletionInFlight.current = false;
      setDeletingIds(new Set());
    }
  };

  const presentIds = new Set(apps.map((app) => app.id));
  const visibleApps = [
    ...apps,
    ...admittedRows.current.filter(
      (app) => deletingIds.has(app.id) && !presentIds.has(app.id),
    ),
  ];
  if (!deletingIds.size && children !== undefined) return <>{children}</>;
  if (visibleApps.length === 0) return <>{children ?? null}</>;

  const dialogCount = deleteTargets?.length ?? 0;

  return (
    <>
      <BulkSelectionBar
        count={selectedIds.size}
        onClear={() => setSelectedIds(new Set())}
        onDelete={() =>
          setDeleteTargets(visibleApps.filter((app) => selectedIds.has(app.id)))
        }
        deleteDisabled={deletingIds.size > 0}
        labels={{
          selected: t("cloud.apps.selectedCount", {
            count: selectedIds.size,
            defaultValue: "{{count}} selected",
          }),
          clear: t("cloud.apps.clearSelection", { defaultValue: "Clear" }),
          deleteSelected: t("cloud.apps.deleteSelected", {
            defaultValue: "Delete selected",
          }),
        }}
      />

      <AppsListView
        apps={visibleApps}
        deletingIds={deletingIds}
        deleteDisabled={deletingIds.size > 0}
        renderAppLink={({ app, className, children }) => (
          <Link to={`/cloud/apps/${app.id}`} className={className}>
            {children}
          </Link>
        )}
        onCopyUrl={(app) => void handleCopyUrl(app.app_url)}
        onDeleteApp={(app) => {
          if (!deletionInFlight.current) setDeleteTargets([app as App]);
        }}
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

      <BulkDeleteDialog
        open={deleteTargets !== null}
        onOpenChange={(open) => !open && setDeleteTargets(null)}
        title={
          dialogCount > 1
            ? t("cloud.apps.deleteDialog.titleMany", {
                count: dialogCount,
                defaultValue: "Delete {{count}} Apps",
              })
            : t("cloud.apps.deleteDialog.title", {
                defaultValue: "Delete App",
              })
        }
        description={
          <>
            {t("cloud.apps.deleteDialog.confirmPrefix", {
              defaultValue: "Are you sure you want to delete",
            })}{" "}
            <span className="font-semibold text-txt-strong">
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
          </>
        }
        cancelLabel={t("cloud.apps.deleteDialog.cancel", {
          defaultValue: "Cancel",
        })}
        confirmLabel={t("cloud.apps.deleteDialog.delete", {
          defaultValue: "Delete",
        })}
        onConfirm={handleConfirmDelete}
      />
    </>
  );
}
