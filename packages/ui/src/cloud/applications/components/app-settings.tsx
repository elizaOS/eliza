/**
 * Manages Cloud publication metadata, origins, credentials, and destructive
 * controls. Routed Cloud details and embedded project publication share this
 * component; callbacks let the project owner preserve or clear its local
 * binding at the correct boundary.
 */

import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CloudOff,
  Key,
  Loader2,
  Plus,
  Save,
  Settings,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
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
  AlertDialogTrigger,
} from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Switch } from "../../../components/ui/switch";
import { Textarea } from "../../../components/ui/textarea";
import { useCloudT } from "../../shell/CloudI18nProvider";
import {
  APPS_QUERY_KEY,
  type App,
  appQueryKey,
  deleteApp,
  regenerateAppApiKey,
  updateApp,
} from "../lib/apps";
import { storeOneTimeAppApiKey } from "../lib/one-time-app-api-key";

export interface AppSettingsProps {
  app: App;
  /** Project-owned mode keeps publication state out of the generic edit form. */
  projectPublication?: boolean;
  onApiKeyRegenerated?: (apiKey: string) => void;
  onUnpublish?: () => Promise<void>;
  onDelete?: () => Promise<void>;
}

export function AppSettings({
  app,
  projectPublication = false,
  onApiKeyRegenerated,
  onUnpublish,
  onDelete,
}: AppSettingsProps) {
  const t = useCloudT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isUnpublishing, setIsUnpublishing] = useState(false);

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
      const { is_active, ...editableFields } = formData;
      await updateApp(app.id, {
        ...(projectPublication
          ? editableFields
          : { ...editableFields, is_active }),
        allowed_origins: allowedOrigins,
      });
      toast.success(
        t("cloud.appSettings.updateSuccess", {
          defaultValue: "Project updated successfully",
        }),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: appQueryKey(app.id) }),
        queryClient.invalidateQueries({ queryKey: APPS_QUERY_KEY }),
      ]);
    } catch (error) {
      // error-policy:J4 save failures remain visible through a destructive-safe toast.
      toast.error(
        t("cloud.appSettings.updateFailed", {
          defaultValue: "Failed to update project",
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
      if (onApiKeyRegenerated) {
        onApiKeyRegenerated(apiKey);
      } else {
        navigate(`/dashboard/apps/${app.id}?tab=overview`, {
          preventScrollReset: true,
        });
      }
    } catch (error) {
      // error-policy:J4 credential rotation failures surface without losing the form.
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

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      if (onDelete) {
        await onDelete();
      } else {
        await deleteApp(app.id);
      }
      toast.success(
        t("cloud.appSettings.deleteSuccess", {
          defaultValue: "Published project deleted",
        }),
      );
      await queryClient.invalidateQueries({ queryKey: APPS_QUERY_KEY });
      if (!onDelete) navigate("/dashboard/apps");
    } catch (error) {
      // error-policy:J4 deletion failures leave the publication and dialog recoverable.
      toast.error(
        t("cloud.appSettings.deleteFailed", {
          defaultValue: "Failed to delete published project",
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
      setIsDeleting(false);
    }
  };

  const handleUnpublish = async () => {
    setIsUnpublishing(true);
    try {
      if (onUnpublish) {
        await onUnpublish();
      } else {
        await updateApp(app.id, { is_active: false });
      }
      toast.success(
        t("cloud.appSettings.unpublishSuccess", {
          defaultValue: "Project unpublished",
        }),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: appQueryKey(app.id) }),
        queryClient.invalidateQueries({ queryKey: APPS_QUERY_KEY }),
      ]);
    } catch (error) {
      // error-policy:J4 unpublish failures preserve the live publication state.
      toast.error(
        t("cloud.appSettings.unpublishFailed", {
          defaultValue: "Failed to unpublish project",
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
      setIsUnpublishing(false);
    }
  };

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
      <div className="bg-card rounded-sm p-4 space-y-4">
        <h3 className="text-sm font-medium text-txt flex items-center gap-2">
          <Settings className="h-4 w-4 text-muted" />
          {t("cloud.appSettings.basicSettings", {
            defaultValue: "Basic Settings",
          })}
        </h3>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name" className="text-xs text-neutral-400">
              {t("cloud.appSettings.appName", {
                defaultValue: "Published Project Name",
              })}
            </Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) =>
                setFormData({ ...formData, name: e.target.value })
              }
              placeholder={t("cloud.appSettings.appNamePlaceholder", {
                defaultValue: "My Awesome Project",
              })}
              className="bg-surface border-border  rounded-sm"
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
                defaultValue: "A brief description of your project...",
              })}
              rows={3}
              className="bg-surface border-border  resize-none rounded-sm"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="app_url" className="text-xs text-neutral-400">
                {t("cloud.appSettings.appUrl", {
                  defaultValue: "Published URL",
                })}
              </Label>
              <Input
                id="app_url"
                type="url"
                value={formData.app_url}
                onChange={(e) =>
                  setFormData({ ...formData, app_url: e.target.value })
                }
                placeholder="https://project.example"
                className="bg-surface border-border  rounded-sm"
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
                className="bg-surface border-border  rounded-sm"
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
              placeholder="contact@project.example"
              className="bg-surface border-border  rounded-sm"
            />
          </div>

          {!projectPublication ? (
            <div className="flex items-center justify-between p-3 bg-surface rounded-sm border border-border">
              <div>
                <p className="text-sm font-medium text-txt">
                  {t("cloud.appSettings.activeStatus", {
                    defaultValue: "Active Status",
                  })}
                </p>
                <p className="text-xs text-neutral-500 mt-0.5">
                  {t("cloud.appSettings.activeStatusHint", {
                    defaultValue:
                      "Unpublished projects cannot make API requests",
                  })}
                </p>
              </div>
              <Switch
                id="is_active"
                checked={formData.is_active}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, is_active: checked })
                }
                className="data-[state=checked]:bg-green-500 data-[state=unchecked]:bg-neutral-700"
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className="bg-card rounded-sm p-4 space-y-4">
        <div>
          <h3 className="text-sm font-medium text-txt flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted" />
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
            className="bg-surface border-border  rounded-sm"
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
            className="shrink-0 border-border hover:bg-bg-hover"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        {allowedOrigins.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {allowedOrigins.map((origin) => (
              <Badge
                key={origin}
                className="bg-surface text-muted border-border flex items-center gap-1 pr-1"
              >
                {origin}
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => removeOrigin(origin)}
                  className="ml-1 p-0.5 hover:bg-bg-hover rounded-sm transition-colors"
                >
                  <X className="h-3 w-3" />
                </Button>
              </Badge>
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <Button
          onClick={handleSave}
          disabled={isLoading}
          className="bg-txt text-bg hover:bg-txt/90"
        >
          {isLoading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              {t("cloud.appSettings.saving", { defaultValue: "Saving..." })}
            </>
          ) : (
            <>
              <Save className="h-4 w-4 mr-2" />
              {t("cloud.appSettings.saveChanges", {
                defaultValue: "Save Changes",
              })}
            </>
          )}
        </Button>
      </div>

      <div className="bg-red-500/10 rounded-sm p-4 space-y-4 border border-red-500/20">
        <h3 className="text-sm font-medium text-red-400 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          {t("cloud.appSettings.dangerZone", { defaultValue: "Danger Zone" })}
        </h3>

        <div className="space-y-3">
          {projectPublication && app.is_active ? (
            <div className="flex items-center justify-between p-4 bg-surface rounded-sm border border-red-500/10">
              <div className="min-w-0 flex-1 mr-3">
                <p className="text-sm font-medium text-txt">
                  {t("cloud.appSettings.unpublishProject", {
                    defaultValue: "Unpublish project",
                  })}
                </p>
                <p className="text-xs text-neutral-400 mt-1">
                  {t("cloud.appSettings.unpublishProjectHint", {
                    defaultValue:
                      "Take the public project offline while keeping its Cloud settings and project binding",
                  })}
                </p>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 border-red-500/40 text-red-400 hover:border-red-500 hover:bg-red-500/10 hover:text-red-300"
                    disabled={isUnpublishing}
                  >
                    {isUnpublishing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <CloudOff className="h-4 w-4 mr-1.5" />
                        {t("cloud.appSettings.unpublishProject", {
                          defaultValue: "Unpublish project",
                        })}
                      </>
                    )}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="bg-card border-border">
                  <AlertDialogHeader>
                    <AlertDialogTitle className="text-txt">
                      {t("cloud.appSettings.unpublishDialogTitle", {
                        defaultValue: "Unpublish this project?",
                      })}
                    </AlertDialogTitle>
                    <AlertDialogDescription className="text-neutral-400">
                      {t("cloud.appSettings.unpublishDialogDescription", {
                        defaultValue:
                          "Its public URL and API access will stop working. Hosting versions, domains, analytics, earnings, and the Cloud binding stay in place so you can republish later.",
                      })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="border-border text-txt hover:bg-bg-hover">
                      {t("cloud.appSettings.cancel", {
                        defaultValue: "Cancel",
                      })}
                    </AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleUnpublish}
                      className="bg-red-600 hover:bg-red-700 text-white"
                    >
                      {t("cloud.appSettings.confirmUnpublish", {
                        defaultValue: "Yes, unpublish",
                      })}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ) : null}

          <div className="flex items-center justify-between p-4 bg-surface rounded-sm border border-red-500/10">
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
                  size="sm"
                  className="bg-red-600 hover:bg-red-700 text-white shrink-0"
                  disabled={isRegenerating}
                >
                  {isRegenerating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <Key className="h-4 w-4 mr-1.5" />
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
                        "This action will immediately invalidate your current API key. Your published project will stop working until you update it with the new key. This cannot be undone.",
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="border-border text-txt hover:bg-bg-hover">
                    {t("cloud.appSettings.cancel", { defaultValue: "Cancel" })}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleRegenerateApiKey}
                    className="bg-red-600 hover:bg-red-700 text-white"
                  >
                    {t("cloud.appSettings.regenerateApiKey", {
                      defaultValue: "Regenerate API Key",
                    })}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          <div className="flex items-center justify-between p-4 bg-surface rounded-sm border border-red-500/10">
            <div className="min-w-0 flex-1 mr-3">
              <p className="text-sm font-medium text-txt">
                {t("cloud.appSettings.deleteApp", {
                  defaultValue: "Delete published project",
                })}
              </p>
              <p className="text-xs text-neutral-400 mt-1">
                {t("cloud.appSettings.deleteAppHint", {
                  defaultValue:
                    "Permanently delete this publication and its Cloud data",
                })}
              </p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  className="bg-red-600 hover:bg-red-700 text-white shrink-0"
                  disabled={isDeleting}
                >
                  {isDeleting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <Trash2 className="h-4 w-4 mr-1.5" />
                      {t("cloud.appSettings.deleteApp", {
                        defaultValue: "Delete published project",
                      })}
                    </>
                  )}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="bg-card border-border">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-txt">
                    {t("cloud.appSettings.deleteDialogTitle", {
                      defaultValue: "Delete published project?",
                    })}
                  </AlertDialogTitle>
                  <AlertDialogDescription className="text-neutral-400">
                    {t("cloud.appSettings.deleteDialogIntro", {
                      defaultValue:
                        "This action cannot be undone. This will permanently delete the published project",
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
                    className="bg-red-600 hover:bg-red-700 text-white"
                  >
                    {t("cloud.appSettings.deleteApp", {
                      defaultValue: "Delete published project",
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
