/**
 * Create App dialog — name + app_url + smart defaults.
 *
 * Ported from
 * `@elizaos/cloud-frontend/src/dashboard/apps/_components/create-app-dialog.tsx`.
 * The bare `fetch` calls (check-name + create) are routed through the typed
 * `checkAppNameAvailable()` / `createApp()` helpers so the Steward Bearer token
 * is attached; on success the apps list is invalidated and the user is sent to
 * the new app's Monetization tab to set their inference markup.
 *
 * The API (`POST /api/v1/apps`) only requires `name` and `app_url`; everything
 * else is optional or belongs on the detail page.
 */

import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Copy, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { APPS_QUERY_KEY, checkAppNameAvailable, createApp } from "../lib/apps";
import { useCopyFeedback } from "../lib/use-copy-feedback";

interface CreateAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateAppDialog({ open, onOpenChange }: CreateAppDialogProps) {
  const t = useCloudT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);
  const [name, setName] = useState("");
  const [appUrl, setAppUrl] = useState("");
  const [createdApp, setCreatedApp] = useState<{
    appId: string;
    apiKey: string;
  } | null>(null);
  const { copied, markCopied } = useCopyFeedback();

  // Name availability check — keeps the existing /api/v1/apps/check-name
  // debounce so the submit button reflects collisions before the user clicks.
  const [nameAvailable, setNameAvailable] = useState<boolean | null>(null);
  const [checkingName, setCheckingName] = useState(false);
  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setNameAvailable(null);
      setCheckingName(false);
      return;
    }
    setCheckingName(true);
    checkTimerRef.current = setTimeout(async () => {
      try {
        setNameAvailable(await checkAppNameAvailable(trimmed));
      } catch {
        setNameAvailable(null);
      } finally {
        setCheckingName(false);
      }
    }, 500);
    return () => {
      if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
    };
  }, [name]);

  const isUrlValid = (() => {
    try {
      new URL(appUrl);
      return true;
    } catch {
      return false;
    }
  })();
  const isNameValid =
    name.trim().length >= 2 && nameAvailable !== false && !checkingName;
  const canSubmit = isNameValid && isUrlValid && !isLoading;

  const reset = () => {
    setName("");
    setAppUrl("");
    setCreatedApp(null);
    setNameAvailable(null);
    setCheckingName(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const data = await createApp({
        name: name.trim(),
        app_url: appUrl.trim(),
        allowed_origins: [appUrl.trim()],
      });
      setCreatedApp({ appId: data.app.id, apiKey: data.apiKey });
      await queryClient.invalidateQueries({ queryKey: APPS_QUERY_KEY });
      toast.success(
        t("cloud.apps.create.toastSuccess", {
          defaultValue:
            "App created — copy the API key, you won't see it again",
        }),
      );
    } catch (error) {
      toast.error(
        t("cloud.apps.create.errFailedCreate", {
          defaultValue: "Failed to create app",
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
      setIsLoading(false);
    }
  };

  const copyApiKey = async () => {
    if (!createdApp) return;
    await navigator.clipboard.writeText(createdApp.apiKey);
    markCopied();
    toast.success(
      t("cloud.apps.create.apiKeyCopied", { defaultValue: "API key copied" }),
    );
  };

  const handleClose = () => {
    const target = createdApp
      ? `/dashboard/apps/${createdApp.appId}?tab=monetization`
      : null;
    reset();
    onOpenChange(false);
    if (target) navigate(target);
  };

  if (createdApp) {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Check className="h-5 w-5 text-green-500" />
              {t("cloud.apps.create.successTitle", {
                defaultValue: "App Created",
              })}
            </DialogTitle>
            <DialogDescription>
              {t("cloud.apps.create.copyApiKeyHint", {
                defaultValue: "Copy your API key now — you won't see it again.",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Label className="text-xs text-white/60">
              {t("cloud.apps.create.apiKeyLabel", { defaultValue: "API Key" })}
            </Label>
            <div className="flex gap-2">
              <Input
                value={createdApp.apiKey}
                readOnly
                className="font-mono text-sm"
              />
              <Button
                type="button"
                variant="outline"
                onClick={copyApiKey}
                className="shrink-0"
              >
                {copied ? (
                  <Check className="h-4 w-4 text-green-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-white/40 leading-relaxed">
              {t("cloud.apps.create.apiKeyExplain1", {
                defaultValue:
                  "Most apps don't need this. Users sign in with their own Eliza Cloud account (OAuth), and your app forwards their JWT — earnings go to you, charges go to them. This key is only for",
              })}{" "}
              <strong>
                {t("cloud.apps.create.serverToServer", {
                  defaultValue: "server-to-server",
                })}
              </strong>{" "}
              {t("cloud.apps.create.apiKeyExplain2", {
                defaultValue: "calls where there's no logged-in user.",
              })}
            </p>
          </div>
          <DialogFooter>
            <Button
              onClick={handleClose}
              className="bg-[#FF5800] hover:bg-[#e54f00] w-full sm:w-auto"
            >
              {t("cloud.apps.create.setMarkupCta", {
                defaultValue: "Set Markup & Earnings →",
              })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("cloud.apps.create.title", { defaultValue: "Create New App" })}
          </DialogTitle>
          <DialogDescription>
            {t("cloud.apps.create.desc", {
              defaultValue:
                "Just a name and a URL. You can set markup, allowed origins, and other settings on the app's detail page once it exists.",
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5 py-2">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="app-name">
                {t("cloud.apps.create.nameLabel", { defaultValue: "Name" })}{" "}
                <span className="text-red-500">*</span>
              </Label>
              {checkingName && (
                <Loader2 className="h-3 w-3 animate-spin text-white/40" />
              )}
              {!checkingName && nameAvailable === true && (
                <span className="text-xs text-green-500 inline-flex items-center gap-1">
                  <Check className="h-3 w-3" />{" "}
                  {t("cloud.apps.create.available", {
                    defaultValue: "available",
                  })}
                </span>
              )}
              {!checkingName && nameAvailable === false && (
                <span className="text-xs text-red-400 inline-flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />{" "}
                  {t("cloud.apps.create.taken", { defaultValue: "taken" })}
                </span>
              )}
            </div>
            <Input
              id="app-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("cloud.apps.create.namePlaceholder", {
                defaultValue: "My App",
              })}
              maxLength={100}
              disabled={isLoading}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="app-url">
              {t("cloud.apps.create.urlLabel", { defaultValue: "App URL" })}{" "}
              <span className="text-red-500">*</span>
            </Label>
            <Input
              id="app-url"
              value={appUrl}
              onChange={(e) => setAppUrl(e.target.value)}
              placeholder="https://myapp.com"
              type="url"
              disabled={isLoading}
            />
            <p className="text-xs text-white/40">
              {t("cloud.apps.create.urlHint", {
                defaultValue:
                  "Where your app lives. Used as the default CORS origin and for affiliate redirects.",
              })}
            </p>
          </div>

          <DialogFooter className="flex-col sm:flex-row gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="w-full sm:w-auto"
            >
              {t("cloud.apps.deleteDialog.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit}
              className="bg-[#FF5800] hover:bg-[#e54f00] w-full sm:w-auto"
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />{" "}
                  {t("cloud.apps.create.creating", {
                    defaultValue: "Creating...",
                  })}
                </>
              ) : (
                t("cloud.apps.createApp", { defaultValue: "Create App" })
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
