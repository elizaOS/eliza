/**
 * Application detail — Settings tab (edit fields, allowed origins, danger zone).
 *
 * Bare `fetch` is replaced with the typed `updateApp` / `regenerateAppApiKey` /
 * `deleteApp` helpers. Confirmed deletion removes only this owner's list entry;
 * an unmounted owner cannot publish a late success or navigation.
 */

import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Key,
  Loader2,
  Plus,
  Save,
  Settings,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "../../../bridge/toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Switch } from "../../../components/ui/switch";
import { Textarea } from "../../../components/ui/textarea";
import { useCloudT } from "../../shell/CloudI18nProvider";
import {
  AppDeletionPendingError,
  resumeAppDeletionAndWait,
} from "../lib/app-deletion-client";
import {
  type App,
  appQueryKey,
  deleteApp,
  regenerateAppApiKey,
  updateApp,
} from "../lib/apps";
import { storeOneTimeAppApiKey } from "../lib/one-time-app-api-key";

interface AppSettingsProps {
  app: App;
  appsQueryKey: QueryKey;
  onDeletingChange?: (pending: boolean) => void;
}

export function AppSettings({
  app,
  appsQueryKey,
  onDeletingChange,
}: AppSettingsProps) {
  const t = useCloudT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isCheckingDeletion, setIsCheckingDeletion] = useState(false);
  const [pendingDeletion, setPendingDeletion] =
    useState<AppDeletionPendingError | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const mounted = useRef(true);
  const deletionInFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [allowedOrigins, setAllowedOrigins] = useState<string[]>(() => {
    const origins = app.allowed_origins;
    return Array.isArray(origins)
      ? origins.filter((origin): origin is string => typeof origin === "string")
      : [];
  });
  const [newOrigin, setNewOrigin] = useState("");

  const [formData, setFormData] = useState({
    name: app.name,
    description: app.description || "",
    app_url: app.app_url,
    website_url: app.website_url || "",
    contact_email: app.contact_email || "",
    is_active: app.is_active,
  });

  const handleSave = async () => {
    setIsLoading(true);
    try {
      await updateApp(app.id, { ...formData, allowed_origins: allowedOrigins });
      toast.success(
        t("cloud.appSettings.updateSuccess", {
          defaultValue: "App updated successfully",
        }),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: appQueryKey(app.id) }),
        queryClient.invalidateQueries({ queryKey: appsQueryKey }),
      ]);
    } catch (error) {
      toast.error(
        t("cloud.appSettings.updateFailed", {
          defaultValue: "Failed to update app",
        }),
        {
          description:
            error instanceof Error
              ? error.message
              : t("cloud.appSettings.tryAgain", {
                  defaultValue: "Please try again",
                }),
        },
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegenerateApiKey = async () => {
    setIsRegenerating(true);
    try {
      const apiKey = await regenerateAppApiKey(app.id);
      storeOneTimeAppApiKey(app.id, apiKey);
      toast.success(
        t("cloud.appSettings.regenerateSuccess", {
          defaultValue: "API key regenerated",
        }),
        {
          description: t("cloud.appSettings.regenerateSuccessDescription", {
            defaultValue:
              "Your new API key has been generated. Make sure to save it!",
          }),
        },
      );
      navigate(`/cloud/apps/${app.id}?tab=overview`, {
        preventScrollReset: true,
      });
    } catch (error) {
      toast.error(
        t("cloud.appSettings.regenerateFailed", {
          defaultValue: "Failed to regenerate API key",
        }),
        {
          description:
            error instanceof Error
              ? error.message
              : t("cloud.appSettings.tryAgain", {
                  defaultValue: "Please try again",
                }),
        },
      );
    } finally {
      setIsRegenerating(false);
    }
  };

  const observeDeletion = async (resume: AppDeletionPendingError | null) => {
    if (deletionInFlight.current) return;
    deletionInFlight.current = true;
    setIsDeleting(true);
    setIsCheckingDeletion(true);
    onDeletingChange?.(true);
    let settled = false;
    try {
      if (resume) await resumeAppDeletionAndWait(app.id, resume.jobId);
      else await deleteApp(app.id);
      if (!mounted.current) return;
      settled = true;
      setPendingDeletion(null);
      queryClient.setQueryData<App[]>(appsQueryKey, (previous) =>
        previous?.filter((candidate) => candidate.id !== app.id),
      );
      toast.success(
        t("cloud.appSettings.deleteSuccess", {
          defaultValue: "App deleted successfully",
        }),
      );
      navigate("/cloud/apps");
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof AppDeletionPendingError && error.appId === app.id) {
        setPendingDeletion(error);
        return;
      }
      settled = true;
      toast.error(
        t("cloud.appSettings.deleteFailed", {
          defaultValue: "Failed to delete app",
        }),
        {
          description:
            error instanceof Error
              ? error.message
              : t("cloud.appSettings.tryAgain", {
                  defaultValue: "Please try again",
                }),
        },
      );
    } finally {
      deletionInFlight.current = false;
      if (mounted.current) {
        setIsCheckingDeletion(false);
        if (settled) {
          setIsDeleting(false);
          onDeletingChange?.(false);
        }
      }
    }
  };
  const handleDelete = () => observeDeletion(null);

  const addOrigin = () => {
    if (newOrigin && !allowedOrigins.includes(newOrigin)) {
      setAllowedOrigins([...allowedOrigins, newOrigin]);
      setNewOrigin("");
    }
  };

  const removeOrigin = (origin: string) => {
    setAllowedOrigins(allowedOrigins.filter((o) => o !== origin));
  };

  return (
    <div className="space-y-4">
      {pendingDeletion && (
        <Card stack="default" variant="flatPadded">
          <div role="status" className="space-y-3">
            <p>
              {pendingDeletion.reason === "recovery_required"
                ? t("cloud.apps.deletionRecoveryRequired", {
                    defaultValue:
                      "The deletion job requires recovery. Its original request is retained and the app remains locked.",
                  })
                : t("cloud.apps.deletionStillPending", {
                    defaultValue:
                      "Deletion is still pending. Its status could not be confirmed; the original request is retained.",
                  })}
            </p>
            <Button
              onClick={() => void observeDeletion(pendingDeletion)}
              disabled={isCheckingDeletion}
            >
              {isCheckingDeletion
                ? t("cloud.apps.checkingDeletionStatus", {
                    defaultValue: "Checking deletion status…",
                  })
                : t("cloud.apps.checkDeletionStatus", {
                    defaultValue: "Check deletion status",
                  })}
            </Button>
          </div>
        </Card>
      )}
      {/* Basic Settings */}
      <Card stack="default" variant="flatPadded">
        <h3 className="text-sm font-medium text-txt flex items-center gap-2">
          <Settings className="size-4 text-muted" />
          {t("cloud.appSettings.basicSettings", {
            defaultValue: "Basic Settings",
          })}
        </h3>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name" className="text-xs text-neutral-400">
              {t("cloud.appSettings.appName", { defaultValue: "App Name" })}
            </Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) =>
                setFormData({ ...formData, name: e.target.value })
              }
              placeholder={t("cloud.appSettings.appNamePlaceholder", {
                defaultValue: "My Awesome App",
              })}
              variant="form"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description" className="text-xs text-neutral-400">
              {t("cloud.appSettings.description", {
                defaultValue: "Description",
              })}
            </Label>
            <Textarea
              id="description"
              value={formData.description}
              onChange={(e) =>
                setFormData({ ...formData, description: e.target.value })
              }
              placeholder={t("cloud.appSettings.descriptionPlaceholder", {
                defaultValue: "A brief description of your app...",
              })}
              rows={3}
              variant="form"
              className="resize-none"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="app_url" className="text-xs text-neutral-400">
                {t("cloud.appSettings.appUrl", { defaultValue: "App URL" })}
              </Label>
              <Input
                id="app_url"
                type="url"
                value={formData.app_url}
                onChange={(e) =>
                  setFormData({ ...formData, app_url: e.target.value })
                }
                placeholder="https://myapp.com"
                variant="form"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="website_url" className="text-xs text-neutral-400">
                {t("cloud.appSettings.websiteUrl", {
                  defaultValue: "Website URL",
                })}
              </Label>
              <Input
                id="website_url"
                type="url"
                value={formData.website_url}
                onChange={(e) =>
                  setFormData({ ...formData, website_url: e.target.value })
                }
                placeholder="https://website.com"
                variant="form"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="contact_email" className="text-xs text-neutral-400">
              {t("cloud.appSettings.contactEmail", {
                defaultValue: "Contact Email",
              })}
            </Label>
            <Input
              id="contact_email"
              type="email"
              value={formData.contact_email}
              onChange={(e) =>
                setFormData({ ...formData, contact_email: e.target.value })
              }
              placeholder="contact@myapp.com"
              variant="form"
            />
          </div>

          <Card flow="rowBetween" gap="default" variant="insetPadded">
            <div>
              <Label
                htmlFor="is_active"
                className="text-sm font-medium text-txt"
              >
                {t("cloud.appSettings.activeStatus", {
                  defaultValue: "Active Status",
                })}
              </Label>
              <p
                id="is_active-hint"
                className="text-xs text-neutral-500 mt-0.5 text-pretty"
              >
                {t("cloud.appSettings.activeStatusHint", {
                  defaultValue: "Inactive apps cannot make API requests",
                })}
              </p>
            </div>
            <Switch
              id="is_active"
              aria-describedby="is_active-hint"
              checked={formData.is_active}
              onCheckedChange={(checked) =>
                setFormData({ ...formData, is_active: checked })
              }
            />
          </Card>
        </div>
      </Card>

      {/* Allowed Origins */}
      <Card stack="default" variant="flatPadded">
        <div>
          <h3 className="text-sm font-medium text-txt flex items-center gap-2">
            <Shield className="size-4 text-muted" />
            {t("cloud.appSettings.allowedOrigins", {
              defaultValue: "Allowed Origins",
            })}
          </h3>
          <p className="text-xs text-neutral-500 mt-1">
            {t("cloud.appSettings.allowedOriginsHint", {
              defaultValue: "API requests are only accepted from these domains",
            })}
          </p>
        </div>

        <div className="flex gap-2">
          <Input
            value={newOrigin}
            onChange={(e) => setNewOrigin(e.target.value)}
            placeholder="https://example.com"
            variant="form"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addOrigin();
              }
            }}
          />
          <Button
            type="button"
            onClick={addOrigin}
            variant="outline"
            size="icon"
            className="shrink-0"
          >
            <Plus className="size-4" />
          </Button>
        </div>

        {allowedOrigins.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {allowedOrigins.map((origin) => (
              <Badge key={origin} variant="outline">
                {origin}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  type="button"
                  onClick={() => removeOrigin(origin)}
                  className="ml-1"
                >
                  <X className="size-3" />
                </Button>
              </Badge>
            ))}
          </div>
        )}
      </Card>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isLoading || isDeleting}>
          {isLoading ? (
            <>
              <Loader2 className="size-4 mr-2 animate-spin" />
              {t("cloud.appSettings.saving", { defaultValue: "Saving..." })}
            </>
          ) : (
            <>
              <Save className="size-4 mr-2" />
              {t("cloud.appSettings.saveChanges", {
                defaultValue: "Save Changes",
              })}
            </>
          )}
        </Button>
      </div>

      {/* Danger Zone */}
      <div className="bg-destructive-subtle rounded-sm p-4 space-y-4 border border-destructive/20">
        <h3 className="text-sm font-medium text-destructive flex items-center gap-2">
          <AlertTriangle className="size-4" />
          {t("cloud.appSettings.dangerZone", { defaultValue: "Danger Zone" })}
        </h3>

        <div className="space-y-3">
          <div className="flex items-center justify-between border-l-2 border-destructive/40 bg-destructive-subtle/50 p-4">
            <div className="min-w-0 flex-1 mr-3">
              <p className="text-sm font-medium text-txt">
                {t("cloud.appSettings.regenerateApiKey", {
                  defaultValue: "Regenerate API Key",
                })}
              </p>
              <p className="text-xs text-neutral-400 mt-1">
                {t("cloud.appSettings.regenerateApiKeyHint", {
                  defaultValue: "This will invalidate the current API key",
                })}
              </p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  size="sm"
                  className="shrink-0"
                  disabled={isRegenerating || isDeleting}
                >
                  {isRegenerating ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <>
                      <Key className="size-4 mr-1.5" />
                      {t("cloud.appSettings.regenerate", {
                        defaultValue: "Regenerate",
                      })}
                    </>
                  )}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="bg-card border-border">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-txt">
                    {t("cloud.appSettings.regenerateDialogTitle", {
                      defaultValue: "Regenerate API Key?",
                    })}
                  </AlertDialogTitle>
                  <AlertDialogDescription className="text-neutral-400">
                    {t("cloud.appSettings.regenerateDialogDescription", {
                      defaultValue:
                        "This action will immediately invalidate your current API key. Your app will stop working until you update it with the new key. This cannot be undone.",
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="border-border text-txt hover:bg-bg-hover">
                    {t("cloud.appSettings.cancel", { defaultValue: "Cancel" })}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleRegenerateApiKey}
                    disabled={isDeleting}
                    className="bg-destructive-solid text-destructive-fg hover:bg-destructive-solid-hover"
                  >
                    {t("cloud.appSettings.regenerateApiKey", {
                      defaultValue: "Regenerate API Key",
                    })}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          <div className="flex items-center justify-between border-l-2 border-destructive/40 bg-destructive-subtle/50 p-4">
            <div className="min-w-0 flex-1 mr-3">
              <p className="text-sm font-medium text-txt">
                {t("cloud.appSettings.deleteApp", {
                  defaultValue: "Delete App",
                })}
              </p>
              <p className="text-xs text-neutral-400 mt-1">
                {t("cloud.appSettings.deleteAppHint", {
                  defaultValue: "Permanently delete this app and all data",
                })}
              </p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  size="sm"
                  className="shrink-0"
                  disabled={isDeleting}
                >
                  {isDeleting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <>
                      <Trash2 className="size-4 mr-1.5" />
                      {t("cloud.appSettings.deleteApp", {
                        defaultValue: "Delete App",
                      })}
                    </>
                  )}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="bg-card border-border">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-txt">
                    {t("cloud.appSettings.deleteDialogTitle", {
                      defaultValue: "Delete App?",
                    })}
                  </AlertDialogTitle>
                  <AlertDialogDescription className="text-neutral-400">
                    {t("cloud.appSettings.deleteDialogIntro", {
                      defaultValue:
                        "This action cannot be undone. This will permanently delete the app",
                    })}
                    <strong className="text-txt"> {app.name}</strong>{" "}
                    {t("cloud.appSettings.deleteDialogOutro", {
                      defaultValue:
                        "and remove all associated data including analytics and user tracking.",
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="border-border text-txt hover:bg-bg-hover">
                    {t("cloud.appSettings.cancel", { defaultValue: "Cancel" })}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleDelete}
                    className="bg-destructive-solid text-destructive-fg hover:bg-destructive-solid-hover"
                  >
                    {t("cloud.appSettings.deleteApp", {
                      defaultValue: "Delete App",
                    })}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>
    </div>
  );
}
