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
  AlertDialogTrigger,
  Badge,
  Button,
  Input,
  Label,
  Switch,
  Textarea,
} from "@elizaos/cloud-ui";
import { AlertTriangle, Key, Loader2, Plus, Save, Settings, Shield, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { App } from "../../../lib/data/apps";

interface AppSettingsProps {
  app: App;
}

export function AppSettings({ app }: AppSettingsProps) {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);

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
      const response = await fetch(`/api/v1/apps/${app.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...formData,
          allowed_origins: allowedOrigins,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to update app");
      }

      toast.success("App updated successfully");
      window.location.reload();
    } catch (error) {
      console.error("Error updating app:", error);
      toast.error("Failed to update app", {
        description: error instanceof Error ? error.message : "Please try again",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegenerateApiKey = async () => {
    setIsRegenerating(true);
    try {
      const response = await fetch(`/api/v1/apps/${app.id}/regenerate-api-key`, {
        method: "POST",
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to regenerate API key");
      }

      const data = await response.json();

      toast.success("API key regenerated", {
        description: "Your new API key has been generated. Make sure to save it!",
      });

      navigate(`/dashboard/apps/${app.id}?showApiKey=${data.apiKey}&tab=overview`);
      window.location.reload();
    } catch (error) {
      console.error("Error regenerating API key:", error);
      toast.error("Failed to regenerate API key", {
        description: error instanceof Error ? error.message : "Please try again",
      });
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/v1/apps/${app.id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to delete app");
      }

      toast.success("App deleted successfully");
      navigate("/dashboard/apps");
      window.location.reload();
    } catch (error) {
      console.error("Error deleting app:", error);
      toast.error("Failed to delete app", {
        description: error instanceof Error ? error.message : "Please try again",
      });
    } finally {
      setIsDeleting(false);
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
      {/* Basic Settings */}
      <div className="bg-neutral-900 rounded-xl p-4 space-y-4">
        <h3 className="text-sm font-medium text-white flex items-center gap-2">
          <Settings className="h-4 w-4 text-[#FF5800]" />
          Basic Settings
        </h3>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name" className="text-xs text-neutral-400">
              App Name
            </Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="My Awesome App"
              className="bg-black/40 border-white/10 focus:border-[#FF5800]/50 rounded-lg"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description" className="text-xs text-neutral-400">
              Description
            </Label>
            <Textarea
              id="description"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="A brief description of your app..."
              rows={3}
              className="bg-black/40 border-white/10 focus:border-[#FF5800]/50 resize-none rounded-lg"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="app_url" className="text-xs text-neutral-400">
                App URL
              </Label>
              <Input
                id="app_url"
                type="url"
                value={formData.app_url}
                onChange={(e) => setFormData({ ...formData, app_url: e.target.value })}
                placeholder="https://myapp.com"
                className="bg-black/40 border-white/10 focus:border-[#FF5800]/50 rounded-lg"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="website_url" className="text-xs text-neutral-400">
                Website URL
              </Label>
              <Input
                id="website_url"
                type="url"
                value={formData.website_url}
                onChange={(e) => setFormData({ ...formData, website_url: e.target.value })}
                placeholder="https://website.com"
                className="bg-black/40 border-white/10 focus:border-[#FF5800]/50 rounded-lg"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="contact_email" className="text-xs text-neutral-400">
              Contact Email
            </Label>
            <Input
              id="contact_email"
              type="email"
              value={formData.contact_email}
              onChange={(e) => setFormData({ ...formData, contact_email: e.target.value })}
              placeholder="contact@myapp.com"
              className="bg-black/40 border-white/10 focus:border-[#FF5800]/50 rounded-lg"
            />
          </div>

          <div className="flex items-center justify-between p-3 bg-black/30 rounded-lg border border-white/10">
            <div>
              <p className="text-sm font-medium text-white">Active Status</p>
              <p className="text-xs text-neutral-500 mt-0.5">
                Inactive apps cannot make API requests
              </p>
            </div>
            <Switch
              id="is_active"
              checked={formData.is_active}
              onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
              className="data-[state=checked]:bg-green-500 data-[state=unchecked]:bg-neutral-700"
            />
          </div>
        </div>
      </div>

      {/* Allowed Origins */}
      <div className="bg-neutral-900 rounded-xl p-4 space-y-4">
        <div>
          <h3 className="text-sm font-medium text-white flex items-center gap-2">
            <Shield className="h-4 w-4 text-blue-400" />
            Allowed Origins
          </h3>
          <p className="text-xs text-neutral-500 mt-1">
            API requests are only accepted from these domains
          </p>
        </div>

        <div className="flex gap-2">
          <Input
            value={newOrigin}
            onChange={(e) => setNewOrigin(e.target.value)}
            placeholder="https://example.com"
            className="bg-black/40 border-white/10 focus:border-[#FF5800]/50 rounded-lg"
            onKeyPress={(e) => {
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
            className="shrink-0 border-white/10 hover:bg-white/10"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        {allowedOrigins.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {allowedOrigins.map((origin) => (
              <Badge
                key={origin}
                className="bg-white/5 text-white/70 border-white/10 flex items-center gap-1 pr-1"
              >
                {origin}
                <button
                  type="button"
                  onClick={() => removeOrigin(origin)}
                  className="ml-1 p-0.5 hover:bg-white/10 rounded transition-colors"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button
          onClick={handleSave}
          disabled={isLoading}
          className="bg-[#FF5800] hover:bg-[#FF5800]/80 text-white"
        >
          {isLoading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="h-4 w-4 mr-2" />
              Save Changes
            </>
          )}
        </Button>
      </div>

      {/* Danger Zone */}
      <div className="bg-red-500/10 rounded-xl p-4 space-y-4 border border-red-500/20">
        <h3 className="text-sm font-medium text-red-400 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          Danger Zone
        </h3>

        <div className="space-y-3">
          <div className="flex items-center justify-between p-4 bg-black rounded-lg border border-red-500/10">
            <div className="min-w-0 flex-1 mr-3">
              <p className="text-sm font-medium text-white">Regenerate API Key</p>
              <p className="text-xs text-neutral-400 mt-1">
                This will invalidate the current API key
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
                      Regenerate
                    </>
                  )}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="bg-neutral-900 border-white/10">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-white">Regenerate API Key?</AlertDialogTitle>
                  <AlertDialogDescription className="text-neutral-400">
                    This action will immediately invalidate your current API key. Your app will stop
                    working until you update it with the new key. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="border-white/10 text-white hover:bg-white/10">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleRegenerateApiKey}
                    className="bg-red-600 hover:bg-red-700 text-white"
                  >
                    Regenerate API Key
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          <div className="flex items-center justify-between p-4 bg-black rounded-lg border border-red-500/10">
            <div className="min-w-0 flex-1 mr-3">
              <p className="text-sm font-medium text-white">Delete App</p>
              <p className="text-xs text-neutral-400 mt-1">
                Permanently delete this app and all data
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
                      Delete App
                    </>
                  )}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="bg-neutral-900 border-white/10">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-white">Delete App?</AlertDialogTitle>
                  <AlertDialogDescription className="text-neutral-400">
                    This action cannot be undone. This will permanently delete the app
                    <strong className="text-white"> {app.name}</strong> and remove all associated
                    data including analytics and user tracking.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="border-white/10 text-white hover:bg-white/10">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleDelete}
                    className="bg-red-600 hover:bg-red-700 text-white"
                  >
                    Delete App
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
