/**
 * Create App dialog — minimal: name + app_url + smart defaults.
 *
 * The API (`POST /api/v1/apps`) only requires `name` and `app_url`.
 * Everything else (description, support_email, allowed_origins,
 * features, affiliate code) is either optional or belongs on a
 * different surface:
 *   - allowed_origins → defaults to [app_url]; tweak later in the
 *     app detail page if you need extra CORS origins
 *   - features (chat/image/video/...) → not enforced at the API
 *     level for the message routes; agents call what they're
 *     authorized for and the cloud bills accordingly
 *   - affiliate code → its own program at /dashboard/affiliates,
 *     orthogonal to apps; one user can have one app + many codes
 *
 * After creation the success state shows the API key once (use it!)
 * then redirects to the detail page Monetization tab so the creator
 * can set their inference markup % — that's the one knob worth
 * surfacing prominently.
 */

"use client";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@elizaos/cloud-ui";
import { AlertCircle, Check, Copy, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

interface CreateAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateAppDialog({ open, onOpenChange }: CreateAppDialogProps) {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [name, setName] = useState("");
  const [appUrl, setAppUrl] = useState("");
  const [createdApp, setCreatedApp] = useState<{
    appId: string;
    apiKey: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // Name availability check — keeps the existing /api/v1/apps/check-name
  // debounce so the submit button reflects collisions before the user clicks.
  const [nameAvailable, setNameAvailable] = useState<boolean | null>(null);
  const [checkingName, setCheckingName] = useState(false);
  const checkTimerRef = useRef<NodeJS.Timeout | null>(null);

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
        const res = await fetch("/api/v1/apps/check-name", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
        if (res.ok) {
          const data = await res.json();
          setNameAvailable(Boolean(data.available));
        } else {
          setNameAvailable(null);
        }
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
  const isNameValid = name.trim().length >= 2 && nameAvailable !== false && !checkingName;
  const canSubmit = isNameValid && isUrlValid && !isLoading;

  const reset = () => {
    setName("");
    setAppUrl("");
    setCreatedApp(null);
    setCopied(false);
    setNameAvailable(null);
    setCheckingName(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const res = await fetch("/api/v1/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          app_url: appUrl.trim(),
          allowed_origins: [appUrl.trim()],
        }),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || "Failed to create app");
      }
      const data = await res.json();
      setCreatedApp({ appId: data.app.id, apiKey: data.apiKey });
      toast.success("App created — copy the API key, you won't see it again");
    } catch (error) {
      toast.error("Failed to create app", {
        description: error instanceof Error ? error.message : "Please try again",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const copyApiKey = async () => {
    if (!createdApp) return;
    await navigator.clipboard.writeText(createdApp.apiKey);
    setCopied(true);
    toast.success("API key copied");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClose = () => {
    const target = createdApp ? `/dashboard/apps/${createdApp.appId}?tab=monetization` : null;
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
              App Created
            </DialogTitle>
            <DialogDescription>
              Copy your API key now — you won&apos;t see it again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Label className="text-xs text-white/60">API Key</Label>
            <div className="flex gap-2">
              <Input value={createdApp.apiKey} readOnly className="font-mono text-sm" />
              <Button type="button" variant="outline" onClick={copyApiKey} className="shrink-0">
                {copied ? (
                  <Check className="h-4 w-4 text-green-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-white/40 leading-relaxed">
              Most apps don't need this. Users sign in with their own Eliza Cloud account (OAuth),
              and your app forwards their JWT — earnings go to you, charges go to them. This key is
              only for <strong>server-to-server</strong> calls where there's no logged-in user.
            </p>
          </div>
          <DialogFooter>
            <Button
              onClick={handleClose}
              className="bg-[#FF5800] hover:bg-[#FF5800]/90 w-full sm:w-auto"
            >
              Set Markup &amp; Earnings →
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
          <DialogTitle>Create New App</DialogTitle>
          <DialogDescription>
            Just a name and a URL. You can set markup, allowed origins, and other settings on the
            app's detail page once it exists.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5 py-2">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="app-name">
                Name <span className="text-red-500">*</span>
              </Label>
              {checkingName && <Loader2 className="h-3 w-3 animate-spin text-white/40" />}
              {!checkingName && nameAvailable === true && (
                <span className="text-xs text-green-500 inline-flex items-center gap-1">
                  <Check className="h-3 w-3" /> available
                </span>
              )}
              {!checkingName && nameAvailable === false && (
                <span className="text-xs text-red-400 inline-flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" /> taken
                </span>
              )}
            </div>
            <Input
              id="app-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My App"
              maxLength={100}
              disabled={isLoading}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="app-url">
              App URL <span className="text-red-500">*</span>
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
              Where your app lives. Used as the default CORS origin and for affiliate redirects.
            </p>
          </div>

          <DialogFooter className="flex-col sm:flex-row gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit}
              className="bg-[#FF5800] hover:bg-[#FF5800]/90 w-full sm:w-auto"
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating...
                </>
              ) : (
                "Create App"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
