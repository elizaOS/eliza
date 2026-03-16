/**
 * Create app dialog component for creating new applications.
 * Supports app name, description, URLs, and allowed origins configuration.
 * Displays created app details with API key after successful creation.
 *
 * @param props - Create app dialog configuration
 * @param props.open - Whether dialog is open
 * @param props.onOpenChange - Callback when dialog open state changes
 */

"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Loader2,
  Plus,
  X,
  Copy,
  Check,
  HelpCircle,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { MessageSquare, Image, Video, Mic, Bot, Database } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";

interface CreatedAppData {
  appId: string;
  apiKey: string;
  appName: string;
}

interface CreateAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MIN_DESCRIPTION_LENGTH = 10;

export function CreateAppDialog({ open, onOpenChange }: CreateAppDialogProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [allowedOrigins, setAllowedOrigins] = useState<string[]>([]);
  const [newOrigin, setNewOrigin] = useState("");
  const [createdApp, setCreatedApp] = useState<CreatedAppData | null>(null);
  const [copied, setCopied] = useState(false);

  // Name validation state
  const [nameValidation, setNameValidation] = useState<{
    isChecking: boolean;
    isAvailable: boolean | null;
    error: string | null;
    suggestedName: string | null;
  }>({
    isChecking: false,
    isAvailable: null,
    error: null,
    suggestedName: null,
  });
  const nameCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const featureIcons = {
    chat: MessageSquare,
    image: Image,
    video: Video,
    voice: Mic,
    agents: Bot,
    embedding: Database,
  };

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    app_url: "",
    website_url: "",
    contact_email: "",
    generate_affiliate_code: false,
    features: {
      chat: true,
      image: false,
      video: false,
      voice: false,
      agents: false,
      embedding: false,
    },
  });

  // Debounced name availability check
  useEffect(() => {
    if (nameCheckTimeoutRef.current) {
      clearTimeout(nameCheckTimeoutRef.current);
    }

    const trimmedName = formData.name.trim();

    if (!trimmedName || trimmedName.length < 2) {
      setNameValidation({
        isChecking: false,
        isAvailable: null,
        error:
          trimmedName.length > 0 && trimmedName.length < 2
            ? "Name must be at least 2 characters"
            : null,
        suggestedName: null,
      });
      return;
    }

    setNameValidation((prev) => ({ ...prev, isChecking: true, error: null }));

    nameCheckTimeoutRef.current = setTimeout(async () => {
      try {
        const response = await fetch("/api/v1/apps/check-name", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmedName }),
        });

        if (response.ok) {
          const data = await response.json();
          setNameValidation({
            isChecking: false,
            isAvailable: data.available,
            error: data.available
              ? null
              : data.conflictType === "subdomain"
                ? "This name would create a subdomain that is already in use"
                : "An app with this name already exists",
            suggestedName: data.suggestedName || null,
          });
        } else {
          setNameValidation({
            isChecking: false,
            isAvailable: null,
            error: null,
            suggestedName: null,
          });
        }
      } catch {
        setNameValidation({
          isChecking: false,
          isAvailable: null,
          error: null,
          suggestedName: null,
        });
      }
    }, 500);

    return () => {
      if (nameCheckTimeoutRef.current) {
        clearTimeout(nameCheckTimeoutRef.current);
      }
    };
  }, [formData.name]);

  // Validation helpers
  const isNameValid =
    formData.name.trim().length >= 2 &&
    formData.name.length <= 100 &&
    !nameValidation.isChecking &&
    nameValidation.isAvailable !== false;

  const isDescriptionValid =
    formData.description.length >= MIN_DESCRIPTION_LENGTH;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const response = await fetch("/api/v1/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...formData,
          allowed_origins:
            allowedOrigins.length > 0 ? allowedOrigins : [formData.app_url],
          features_enabled: formData.features,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to create app");
      }

      const data = await response.json();

      // Show the API key in the success state
      setCreatedApp({
        appId: data.app.id,
        apiKey: data.apiKey,
        appName: formData.name,
      });

      toast.success("App created successfully!", {
        description:
          "Your API key has been generated. Make sure to save it securely.",
      });
    } catch (error) {
      console.error("Error creating app:", error);
      toast.error("Failed to create app", {
        description:
          error instanceof Error ? error.message : "Please try again",
      });
    } finally {
      setIsLoading(false);
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

  const copyApiKey = async () => {
    if (!createdApp) return;
    await navigator.clipboard.writeText(createdApp.apiKey);
    setCopied(true);
    toast.success("API key copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClose = () => {
    if (createdApp) {
      // Navigate to the app page after closing
      router.push(`/dashboard/apps/${createdApp.appId}`);
    }
    // Reset all state
    setCreatedApp(null);
    setCopied(false);
    setNameValidation({
      isChecking: false,
      isAvailable: null,
      error: null,
      suggestedName: null,
    });
    setFormData({
      name: "",
      description: "",
      app_url: "",
      website_url: "",
      contact_email: "",
      generate_affiliate_code: false,
      features: {
        chat: true,
        image: false,
        video: false,
        voice: false,
        agents: false,
        embedding: false,
      },
    });
    setAllowedOrigins([]);
    onOpenChange(false);
  };

  // Success state - show API key
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

          <div className="space-y-4 py-4">
            <div>
              <Label className="text-xs text-white/60">API Key</Label>
              <div className="flex gap-2 mt-1">
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
            </div>
          </div>

          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              onClick={handleClose}
              variant="outline"
              className="w-full sm:w-auto"
            >
              Go to Overview
            </Button>
            <Button
              onClick={() => {
                router.push(
                  `/dashboard/apps/${createdApp.appId}?tab=monetization`,
                );
                onOpenChange(false);
              }}
              className="bg-gradient-to-r from-[#FF5800] to-purple-600 w-full sm:w-auto"
            >
              Enable Monetization
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create New App</DialogTitle>
          <DialogDescription>
            Create an app to integrate Eliza Cloud services into your website or
            application. You&apos;ll receive an API key for authentication.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Basic Info */}
          <div className="space-y-5">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="name">
                  App Name <span className="text-red-500">*</span>
                </Label>
                <div className="flex items-center gap-2">
                  {nameValidation.isChecking && (
                    <Loader2 className="h-3 w-3 animate-spin text-white/40" />
                  )}
                  {!nameValidation.isChecking &&
                    nameValidation.isAvailable === true &&
                    formData.name.trim().length >= 2 && (
                      <span className="flex items-center gap-1 text-xs text-emerald-400">
                        <Check className="h-3 w-3" />
                        Available
                      </span>
                    )}
                  {!nameValidation.isChecking &&
                    nameValidation.isAvailable === false && (
                      <span className="flex items-center gap-1 text-xs text-red-400">
                        <AlertCircle className="h-3 w-3" />
                        Taken
                      </span>
                    )}
                  <span className="text-xs text-white/40">
                    {formData.name.length}/100
                  </span>
                </div>
              </div>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) =>
                  setFormData({ ...formData, name: e.target.value })
                }
                placeholder="My Awesome App"
                maxLength={100}
                className={
                  nameValidation.error
                    ? "border-red-500/50 focus:border-red-500"
                    : nameValidation.isAvailable === true &&
                        formData.name.trim().length >= 2
                      ? "border-emerald-500/30 focus:border-emerald-500"
                      : ""
                }
                required
              />
              {nameValidation.error && (
                <p className="text-xs text-red-400 flex items-center gap-1.5">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {nameValidation.error}
                  {nameValidation.suggestedName && (
                    <button
                      type="button"
                      onClick={() =>
                        setFormData({
                          ...formData,
                          name: nameValidation.suggestedName!,
                        })
                      }
                      className="ml-1 text-[#FF5800] hover:underline"
                    >
                      Try &quot;{nameValidation.suggestedName}&quot;
                    </button>
                  )}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="description">
                  Description <span className="text-red-500">*</span>
                </Label>
                <span
                  className={`text-xs ${
                    formData.description.length > 0 &&
                    formData.description.length < MIN_DESCRIPTION_LENGTH
                      ? "text-amber-400"
                      : "text-white/40"
                  }`}
                >
                  {formData.description.length} characters (min{" "}
                  {MIN_DESCRIPTION_LENGTH})
                </span>
              </div>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) =>
                  setFormData({ ...formData, description: e.target.value })
                }
                placeholder="A brief description of your app... (minimum 10 characters)"
                rows={3}
                className={
                  formData.description.length > 0 &&
                  formData.description.length < MIN_DESCRIPTION_LENGTH
                    ? "border-amber-500/30 focus:border-amber-500"
                    : formData.description.length >= MIN_DESCRIPTION_LENGTH
                      ? "border-emerald-500/30 focus:border-emerald-500"
                      : ""
                }
              />
              {formData.description.length > 0 &&
                formData.description.length < MIN_DESCRIPTION_LENGTH && (
                  <p className="text-xs text-amber-400 flex items-center gap-1.5">
                    <AlertCircle className="h-3.5 w-3.5" />
                    Description must be at least {MIN_DESCRIPTION_LENGTH}{" "}
                    characters (
                    {MIN_DESCRIPTION_LENGTH - formData.description.length} more
                    needed)
                  </p>
                )}
            </div>

            <div>
              <Label className="mb-3" htmlFor="app_url">
                App URL <span className="text-red-500">*</span>
              </Label>
              <Input
                id="app_url"
                type="url"
                value={formData.app_url}
                onChange={(e) =>
                  setFormData({ ...formData, app_url: e.target.value })
                }
                placeholder="https://myapp.com"
                required
              />
            </div>

            <div>
              <Label className="mb-3" htmlFor="website_url">
                Website URL
              </Label>
              <Input
                id="website_url"
                type="url"
                value={formData.website_url}
                onChange={(e) =>
                  setFormData({ ...formData, website_url: e.target.value })
                }
                placeholder="https://website.com"
              />
            </div>

            <div>
              <Label className="mb-3" htmlFor="contact_email">
                Contact Email
              </Label>
              <Input
                id="contact_email"
                type="email"
                value={formData.contact_email}
                onChange={(e) =>
                  setFormData({ ...formData, contact_email: e.target.value })
                }
                placeholder="contact@myapp.com"
              />
            </div>
          </div>

          {/* URL Whitelist */}
          <div className="space-y-2">
            <div className="flex items-center space-x-2">
              <Label>Allowed Origins (URL Whitelist)</Label>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="w-4 h-4 text-white/60 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">
                      Specify which domains can make requests with your API key.
                      Leave empty to only allow the app URL.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <div className="flex gap-2">
              <Input
                value={newOrigin}
                onChange={(e) => setNewOrigin(e.target.value)}
                placeholder="https://example.com"
                onKeyPress={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addOrigin();
                  }
                }}
              />
              <Button type="button" onClick={addOrigin} variant="outline">
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            {allowedOrigins.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {allowedOrigins.map((origin) => (
                  <Badge
                    key={origin}
                    variant="secondary"
                    className="flex items-center gap-1"
                  >
                    {origin}
                    <button
                      type="button"
                      onClick={() => removeOrigin(origin)}
                      className="ml-1 hover:text-red-400"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Features */}
          <div className="space-y-3">
            <div className="flex items-center space-x-2">
              <Label>Enabled Features</Label>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="w-4 h-4 text-white/60 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">
                      Select which Eliza Cloud features this app can access
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {Object.entries({
                chat: "Chat & Text Generation",
                image: "Image Generation",
                video: "Video Generation",
                voice: "Voice Cloning",
                agents: "Agent Runtime",
                embedding: "Embeddings",
              }).map(([key, label]) => {
                const Icon = featureIcons[key as keyof typeof featureIcons];
                const isChecked =
                  formData.features[key as keyof typeof formData.features];

                return (
                  <div
                    key={key}
                    className={`flex items-center space-x-3 p-3 transition-colors cursor-pointer ${
                      isChecked
                        ? "bg-white/20 border border-white/30"
                        : "bg-white/10 border border-transparent hover:bg-white/15"
                    }`}
                    onClick={() =>
                      setFormData({
                        ...formData,
                        features: {
                          ...formData.features,
                          [key]: !isChecked,
                        },
                      })
                    }
                  >
                    <Icon className="w-4 h-5 text-white/80" />
                    <span className="text-xs flex-1">{label}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Affiliate Code */}
          <div className="flex items-center justify-between p-4 bg-purple-500/10 rounded-lg border border-purple-500/20">
            <div className="flex-1">
              <Label htmlFor="affiliate">Generate Affiliate Code</Label>
              <p className="text-xs text-white/60 mt-1">
                Create a unique referral code to track user signups from your
                app
              </p>
            </div>
            <Switch
              id="affiliate"
              checked={formData.generate_affiliate_code}
              onCheckedChange={(checked) =>
                setFormData({ ...formData, generate_affiliate_code: checked })
              }
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                isLoading ||
                !isNameValid ||
                !isDescriptionValid ||
                nameValidation.isChecking
              }
              className="bg-gradient-to-r from-[#FF5800] to-purple-600"
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : nameValidation.isChecking ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Checking name...
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
