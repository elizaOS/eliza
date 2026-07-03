/**
 * Application detail — Hosting tab. Human UI trigger for the managed
 * frontend-hosting endpoints (#10690, architecture rule 10): list deployment
 * versions, publish a static bundle from local files, activate any ready
 * version (activating an older one is the rollback), delete non-active
 * versions, and preview.
 */

import { formatDistanceToNow } from "date-fns";
import {
  ExternalLink,
  Loader2,
  RefreshCw,
  Rocket,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { EmptyState } from "../../../components/ui/empty-state";
import { Input } from "../../../components/ui/input";
import { ApiError } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";
import {
  activateFrontendDeployment,
  deleteFrontendDeployment,
  type FrontendDeployment,
  filesToBundle,
  frontendPreviewPath,
  listFrontendDeployments,
  publishFrontendBundle,
} from "../lib/frontend-hosting";
import { isNativeAppsStudioRuntime } from "../lib/native-cloud-nav";

interface AppFrontendHostingProps {
  appId: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusBadgeVariant(
  status: FrontendDeployment["status"],
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "active") return "default";
  if (status === "failed") return "destructive";
  if (status === "ready") return "outline";
  return "secondary";
}

export function AppFrontendHosting({ appId }: AppFrontendHostingProps) {
  const t = useCloudT();
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deployments, setDeployments] = useState<FrontendDeployment[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [activateOnPublish, setActivateOnPublish] = useState(true);
  const [isPublishing, setIsPublishing] = useState(false);
  const [busyDeploymentId, setBusyDeploymentId] = useState<string | null>(null);
  const [confirmActivate, setConfirmActivate] =
    useState<FrontendDeployment | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FrontendDeployment | null>(
    null,
  );

  const folderInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);

  const fetchDeployments = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const data = await listFrontendDeployments(appId);
      setDeployments(data.deployments);
      setActiveId(data.active_deployment_id);
    } catch (error) {
      setLoadError(
        error instanceof ApiError
          ? error.message
          : t("cloud.appHosting.loadFailed", {
              defaultValue: "Failed to load deployments",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  }, [appId, t]);

  useEffect(() => {
    fetchDeployments();
  }, [fetchDeployments]);

  const onFilesPicked = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setSelectedFiles(Array.from(list));
  };

  const handlePublish = async () => {
    setIsPublishing(true);
    try {
      const files = await filesToBundle(selectedFiles);
      const deployment = await publishFrontendBundle(appId, {
        files,
        activate: activateOnPublish,
        buildMeta: { source: "dashboard" },
      });
      toast.success(
        t("cloud.appHosting.publishSuccess", {
          defaultValue: "Version {{version}} published",
          version: deployment.version,
        }),
      );
      setSelectedFiles([]);
      if (folderInputRef.current) folderInputRef.current.value = "";
      if (filesInputRef.current) filesInputRef.current.value = "";
      await fetchDeployments();
    } catch (error) {
      const limitMessages: Record<string, string> = {
        bundle_empty: t("cloud.appHosting.errorEmpty", {
          defaultValue: "Select at least one file",
        }),
        bundle_too_many_files: t("cloud.appHosting.errorTooManyFiles", {
          defaultValue: "Bundle exceeds the 2000-file limit",
        }),
        bundle_too_large: t("cloud.appHosting.errorTooLarge", {
          defaultValue: "Bundle exceeds the 25 MB total limit",
        }),
        bundle_file_too_large: t("cloud.appHosting.errorFileTooLarge", {
          defaultValue: "A file exceeds the 10 MB per-file limit",
        }),
      };
      const message =
        error instanceof Error && limitMessages[error.message]
          ? limitMessages[error.message]
          : error instanceof ApiError
            ? error.message
            : t("cloud.appHosting.publishFailed", {
                defaultValue: "Failed to publish deployment",
              });
      toast.error(message);
    } finally {
      setIsPublishing(false);
    }
  };

  const handleActivate = async (deployment: FrontendDeployment) => {
    setBusyDeploymentId(deployment.id);
    try {
      await activateFrontendDeployment(appId, deployment.id);
      toast.success(
        t("cloud.appHosting.activateSuccess", {
          defaultValue: "Version {{version}} is now live",
          version: deployment.version,
        }),
      );
      await fetchDeployments();
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : t("cloud.appHosting.activateFailed", {
              defaultValue: "Failed to activate deployment",
            }),
      );
    } finally {
      setBusyDeploymentId(null);
    }
  };

  const handleDelete = async (deployment: FrontendDeployment) => {
    setBusyDeploymentId(deployment.id);
    try {
      await deleteFrontendDeployment(appId, deployment.id);
      toast.success(
        t("cloud.appHosting.deleteSuccess", {
          defaultValue: "Version {{version}} deleted",
          version: deployment.version,
        }),
      );
      await fetchDeployments();
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : t("cloud.appHosting.deleteFailed", {
              defaultValue: "Failed to delete deployment",
            }),
      );
    } finally {
      setBusyDeploymentId(null);
    }
  };

  const activeVersion =
    deployments.find((d) => d.id === activeId)?.version ?? null;
  const selectedBytes = selectedFiles.reduce((sum, f) => sum + f.size, 0);
  const showPreviewLinks = !isNativeAppsStudioRuntime();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center gap-3 border border-dashed border-border p-8 text-center">
        <p className="text-sm text-muted">{loadError}</p>
        <Button variant="outline" size="sm" onClick={fetchDeployments}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {t("cloud.appHosting.retry", { defaultValue: "Retry" })}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Publish */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-txt">
            {t("cloud.appHosting.publishTitle", {
              defaultValue: "Publish a new version",
            })}
          </h3>
          <p className="text-xs text-muted">
            {t("cloud.appHosting.publishDescription", {
              defaultValue:
                "Upload a built static site (index.html entrypoint). Cloud serves it on your app domains.",
            })}
          </p>
        </div>
        <Input
          ref={folderInputRef}
          type="file"
          className="hidden"
          multiple
          data-testid="hosting-folder-input"
          // Non-standard but the only folder-picker seam in browsers.
          {...{ webkitdirectory: "" }}
          onChange={(e) => onFilesPicked(e.target.files)}
        />
        <Input
          ref={filesInputRef}
          type="file"
          className="hidden"
          multiple
          data-testid="hosting-files-input"
          onChange={(e) => onFilesPicked(e.target.files)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={isPublishing}
            onClick={() => folderInputRef.current?.click()}
          >
            <Upload className="mr-2 h-4 w-4" />
            {t("cloud.appHosting.selectFolder", {
              defaultValue: "Select folder",
            })}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={isPublishing}
            onClick={() => filesInputRef.current?.click()}
          >
            {t("cloud.appHosting.selectFiles", {
              defaultValue: "Select files",
            })}
          </Button>
          <label
            htmlFor="app-hosting-activate-on-publish"
            className="flex items-center gap-2 text-xs text-muted"
          >
            <Input
              id="app-hosting-activate-on-publish"
              type="checkbox"
              checked={activateOnPublish}
              disabled={isPublishing}
              onChange={(e) => setActivateOnPublish(e.target.checked)}
            />
            {t("cloud.appHosting.activateImmediately", {
              defaultValue: "Activate immediately",
            })}
          </label>
        </div>
        {selectedFiles.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
            <span data-testid="hosting-selection-summary">
              {t("cloud.appHosting.selectionSummary", {
                defaultValue: "{{count}} files · {{size}}",
                count: selectedFiles.length,
                size: formatBytes(selectedBytes),
              })}
            </span>
            <Button
              size="sm"
              disabled={isPublishing}
              onClick={handlePublish}
              data-testid="hosting-publish"
            >
              {isPublishing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="mr-2 h-4 w-4" />
              )}
              {t("cloud.appHosting.publish", { defaultValue: "Publish" })}
            </Button>
          </div>
        )}
      </section>

      {/* Versions */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-txt">
            {t("cloud.appHosting.versionsTitle", { defaultValue: "Versions" })}
          </h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchDeployments}
            aria-label={t("cloud.appHosting.refresh", {
              defaultValue: "Refresh",
            })}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        {deployments.length === 0 ? (
          <EmptyState
            variant="dashed"
            icon={<Rocket className="h-6 w-6" />}
            title={t("cloud.appHosting.emptyTitle", {
              defaultValue: "No deployments yet",
            })}
            description={t("cloud.appHosting.emptyDescription", {
              defaultValue:
                "Publish your first version to serve this app's frontend from Cloud",
            })}
          />
        ) : (
          <ul className="divide-y divide-border border border-border">
            {deployments.map((deployment) => {
              const isActive = deployment.id === activeId;
              const isBusy = busyDeploymentId === deployment.id;
              const canActivate =
                !isActive &&
                (deployment.status === "ready" ||
                  deployment.status === "superseded");
              const isRollback =
                canActivate &&
                activeVersion !== null &&
                deployment.version < activeVersion;
              return (
                <li
                  key={deployment.id}
                  data-testid={`hosting-deployment-${deployment.version}`}
                  className="flex flex-wrap items-center gap-3 px-3 py-2.5"
                >
                  <span className="font-mono text-sm text-txt">
                    v{deployment.version}
                  </span>
                  <Badge variant={statusBadgeVariant(deployment.status)}>
                    {deployment.status === "active"
                      ? t("cloud.appHosting.statusLive", {
                          defaultValue: "live",
                        })
                      : deployment.status}
                  </Badge>
                  <span className="text-xs text-muted">
                    {t("cloud.appHosting.deploymentMeta", {
                      defaultValue: "{{count}} files · {{size}}",
                      count: deployment.file_count,
                      size: formatBytes(deployment.total_bytes),
                    })}
                    {" · "}
                    {formatDistanceToNow(new Date(deployment.created_at), {
                      addSuffix: true,
                    })}
                    {deployment.build_meta?.note
                      ? ` · ${deployment.build_meta.note}`
                      : ""}
                  </span>
                  {deployment.status === "failed" && deployment.error && (
                    <span className="text-xs text-destructive">
                      {deployment.error}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-1">
                    {showPreviewLinks &&
                      (isActive ||
                        deployment.status === "ready" ||
                        deployment.status === "superseded") && (
                        <a
                          href={frontendPreviewPath(
                            appId,
                            isActive ? undefined : deployment.id,
                          )}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs text-muted hover:text-txt"
                          aria-label={t("cloud.appHosting.preview", {
                            defaultValue: "Preview",
                          })}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          {t("cloud.appHosting.preview", {
                            defaultValue: "Preview",
                          })}
                        </a>
                      )}
                    {canActivate && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => setConfirmActivate(deployment)}
                        data-testid={`hosting-activate-${deployment.version}`}
                      >
                        {isBusy && (
                          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        )}
                        {isRollback
                          ? t("cloud.appHosting.rollback", {
                              defaultValue: "Roll back",
                            })
                          : t("cloud.appHosting.activate", {
                              defaultValue: "Activate",
                            })}
                      </Button>
                    )}
                    {!isActive && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => setConfirmDelete(deployment)}
                        aria-label={t("cloud.appHosting.delete", {
                          defaultValue: "Delete",
                        })}
                        data-testid={`hosting-delete-${deployment.version}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Activate / rollback confirm */}
      <AlertDialog
        open={confirmActivate !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmActivate(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("cloud.appHosting.activateConfirmTitle", {
                defaultValue: "Make version {{version}} live?",
                version: confirmActivate?.version ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("cloud.appHosting.activateConfirmDescription", {
                defaultValue:
                  "The current live version is replaced immediately on all app domains. It stays available for rollback.",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("cloud.appHosting.cancel", { defaultValue: "Cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="hosting-activate-confirm"
              onClick={() => {
                if (confirmActivate) handleActivate(confirmActivate);
                setConfirmActivate(null);
              }}
            >
              {t("cloud.appHosting.activateConfirm", {
                defaultValue: "Make live",
              })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirm */}
      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("cloud.appHosting.deleteConfirmTitle", {
                defaultValue: "Delete version {{version}}?",
                version: confirmDelete?.version ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("cloud.appHosting.deleteConfirmDescription", {
                defaultValue:
                  "The deployment and its stored files are removed permanently.",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("cloud.appHosting.cancel", { defaultValue: "Cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="hosting-delete-confirm"
              onClick={() => {
                if (confirmDelete) handleDelete(confirmDelete);
                setConfirmDelete(null);
              }}
            >
              {t("cloud.appHosting.delete", { defaultValue: "Delete" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
