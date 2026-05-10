/**
 * API keys page client component for managing API keys.
 * Displays key summary, table, and creation dialog with rate limit and permission configuration.
 *
 * @param props - API keys page client configuration
 * @param props.keys - Array of API key display objects
 * @param props.summary - API keys summary data
 */

"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent as AlertDialogContentComp,
  AlertDialogDescription as AlertDialogDescComp,
  AlertDialogFooter as AlertDialogFooterComp,
  AlertDialogHeader as AlertDialogHeaderComp,
  AlertDialogTitle as AlertDialogTitleComp,
  ApiKeyEmptyState,
  BrandButton,
  DashboardPageContainer,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useSetPageHeader,
} from "@elizaos/cloud-ui";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { copyApiKeyToClipboard, getClientApiKeySecret } from "@/lib/client/api-keys";
import { ApiKeysSummary } from "./api-keys-summary";
import { ApiKeysTable } from "./api-keys-table";
import type { ApiKeyDisplay, ApiKeysSummaryData } from "./types";

interface ApiKeysPageClientProps {
  keys: ApiKeyDisplay[];
  summary: ApiKeysSummaryData;
}

const rateLimitPresets = [
  { value: "standard", label: "Standard - 1,000 req/min" },
  { value: "high", label: "High throughput - 5,000 req/min" },
  { value: "custom", label: "Custom" },
] as const;

const permissionGroups = [
  {
    title: "Core",
    permissions: [
      { id: "read", label: "Read data" },
      { id: "write", label: "Write data" },
      { id: "usage", label: "View usage" },
    ],
  },
  {
    title: "Generations",
    permissions: [
      { id: "text", label: "Text generation" },
      { id: "image", label: "Image generation" },
      { id: "video", label: "Video generation" },
    ],
  },
  {
    title: "Management",
    permissions: [
      { id: "billing", label: "Billing" },
      { id: "team", label: "Team management" },
      { id: "keys", label: "Manage API keys" },
    ],
  },
] as const;

export function ApiKeysPageClient({ keys, summary }: ApiKeysPageClientProps) {
  const queryClient = useQueryClient();
  const refreshApiKeys = () => {
    void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
  };
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [rateLimitPreset, setRateLimitPreset] =
    useState<(typeof rateLimitPresets)[number]["value"]>("standard");
  const [isCreating, setIsCreating] = useState(false);
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    rate_limit: 1000,
  });
  const [createdKey, setCreatedKey] = useState<{
    plainKey: string;
    name: string;
  } | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    type: "disable" | "delete" | "regenerate";
    id: string;
    title: string;
    description: string;
  } | null>(null);

  const hasKeys = keys.length > 0;

  useSetPageHeader({
    title: "API Keys",
    actions: (
      <BrandButton
        variant="primary"
        size="sm"
        className="gap-2"
        onClick={() => setCreateDialogOpen(true)}
      >
        <Plus className="h-4 w-4" />
        Create API Key
      </BrandButton>
    ),
  });

  const handleCreateKey = async () => {
    setIsCreating(true);
    const rateLimit =
      rateLimitPreset === "standard"
        ? 1000
        : rateLimitPreset === "high"
          ? 5000
          : formData.rate_limit;

    const response = await fetch("/api/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: formData.name,
        description: formData.description,
        permissions: selectedPermissions,
        rate_limit: rateLimit,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to create API key");
    }

    // Plaintext secret is only returned on this create response — persist it in
    // local state so it remains visible after the list refetches.
    setCreatedKey({ plainKey: data.plainKey, name: data.apiKey.name });
    setFormData({ name: "", description: "", rate_limit: 1000 });
    setSelectedPermissions([]);
    setRateLimitPreset("standard");
    setCreateDialogOpen(false);
    toast.success("API key created successfully", {
      description: `${data.apiKey.name} has been created and is ready to use.`,
    });
    refreshApiKeys();
    setIsCreating(false);
  };

  const handleCopyKey = async (plainKey: string) => {
    try {
      await copyApiKeyToClipboard(plainKey);
      toast.success("Copied to clipboard", {
        description: "Full API key copied to your clipboard.",
      });
    } catch (error) {
      toast.error("Failed to copy API key", {
        description: error instanceof Error ? error.message : "Clipboard access was blocked.",
      });
    }
  };

  const handleCopyStoredKey = async (id: string) => {
    try {
      const plainKey = await getClientApiKeySecret(id);
      await handleCopyKey(plainKey);
    } catch (error) {
      toast.error("Failed to load API key", {
        description: error instanceof Error ? error.message : "Please try again.",
      });
    }
  };

  const handleDisableKey = async (id: string) => {
    const key = keys.find((k) => k.id === id);
    const isCurrentlyActive = key?.status === "active";
    const action = isCurrentlyActive ? "disable" : "enable";

    setPendingAction({
      type: "disable",
      id,
      title: `${action.charAt(0).toUpperCase() + action.slice(1)} API Key`,
      description: `Are you sure you want to ${action} this API key?`,
    });
  };

  const handleDeleteKey = async (id: string) => {
    setPendingAction({
      type: "delete",
      id,
      title: "Delete API Key",
      description: "Are you sure you want to delete this API key? This action cannot be undone.",
    });
  };

  const handleRegenerateKey = async (id: string) => {
    setPendingAction({
      type: "regenerate",
      id,
      title: "Regenerate API Key",
      description:
        "Are you sure you want to regenerate this API key? The old key will stop working immediately.",
    });
  };

  const handleConfirmAction = async () => {
    if (!pendingAction) return;
    const { type, id } = pendingAction;
    setPendingAction(null);

    if (type === "disable") {
      const key = keys.find((k) => k.id === id);
      const isCurrentlyActive = key?.status === "active";
      const action = isCurrentlyActive ? "disable" : "enable";

      const response = await fetch(`/api/v1/api-keys/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !isCurrentlyActive }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || `Failed to ${action} API key`);
      }

      toast.success(`API key ${action}d`, {
        description: `The API key has been ${action}d successfully.`,
      });
      refreshApiKeys();
    } else if (type === "delete") {
      const response = await fetch(`/api/v1/api-keys/${id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to delete API key");
      }

      toast.success("API key deleted", {
        description: "The API key has been permanently deleted.",
      });
      refreshApiKeys();
    } else if (type === "regenerate") {
      const response = await fetch(`/api/v1/api-keys/${id}/regenerate`, {
        method: "POST",
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to regenerate API key");
      }

      // Same as create: plaintext is only returned now — keep it on screen
      // and refetch the list separately.
      setCreatedKey({ plainKey: data.plainKey, name: data.apiKey.name });
      toast.success("API key regenerated", {
        description: `${data.apiKey.name} has been regenerated. The old key is no longer valid.`,
      });
      refreshApiKeys();
    }
  };

  return (
    <DashboardPageContainer className="flex flex-col gap-6 md:gap-8">
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              Generate a scoped API key with clear permissions and rate limits.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-6">
            <div className="grid gap-2">
              <label
                htmlFor="api-key-name"
                className="text-xs font-medium text-white/70 uppercase tracking-wide"
              >
                Name
              </label>
              <Input
                id="api-key-name"
                placeholder="Production integration"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                autoFocus
                className="rounded-none border-white/10 bg-black/40 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800]"
              />
              <p className="text-xs text-white/50">
                Choose a descriptive name for this key so your team can recognize its purpose.
              </p>
            </div>

            <div className="grid gap-2">
              <label
                htmlFor="api-key-description"
                className="text-xs font-medium text-white/70 uppercase tracking-wide"
              >
                Description
              </label>
              <Textarea
                id="api-key-description"
                placeholder="Used by our backend services for customer facing features"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                rows={3}
                className="rounded-none border-white/10 bg-black/40 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800]"
              />
            </div>

            <div className="grid gap-2">
              <label className="text-xs font-medium text-white/70 uppercase tracking-wide">
                Permissions
              </label>
              <div className="grid gap-3 rounded-none border border-white/10 bg-black/40 p-4">
                {permissionGroups.map((group) => (
                  <div key={group.title} className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-white/50">
                      {group.title}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {group.permissions.map((permission) => {
                        const isSelected = selectedPermissions.includes(permission.id);
                        return (
                          <BrandButton
                            key={permission.id}
                            type="button"
                            variant={isSelected ? "primary" : "outline"}
                            size="sm"
                            className="text-xs"
                            onClick={() => {
                              setSelectedPermissions((prev) =>
                                isSelected
                                  ? prev.filter((p) => p !== permission.id)
                                  : [...prev, permission.id],
                              );
                            }}
                          >
                            {permission.label}
                          </BrandButton>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-2">
              <label className="text-xs font-medium text-white/70 uppercase tracking-wide">
                Rate limit
              </label>
              <Select
                value={rateLimitPreset}
                onValueChange={(value) =>
                  setRateLimitPreset(value as (typeof rateLimitPresets)[number]["value"])
                }
              >
                <SelectTrigger className="rounded-none border-white/10 bg-black/40 text-white focus:ring-1 focus:ring-[#FF5800]">
                  <SelectValue placeholder="Select a limit" />
                </SelectTrigger>
                <SelectContent className="rounded-none border-white/10 bg-black/90">
                  {rateLimitPresets.map((preset) => (
                    <SelectItem
                      key={preset.value}
                      value={preset.value}
                      className="rounded-none text-white hover:bg-white/10 focus:bg-white/10"
                    >
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {rateLimitPreset === "custom" && (
                <div className="grid gap-2 rounded-none border border-dashed border-white/10 bg-black/40 p-4">
                  <label
                    htmlFor="api-key-rate-custom"
                    className="text-xs font-medium text-white/70 uppercase tracking-wide"
                  >
                    Custom requests / minute
                  </label>
                  <Input
                    id="api-key-rate-custom"
                    type="number"
                    placeholder="Enter custom rate limit"
                    value={rateLimitPreset === "custom" ? formData.rate_limit : ""}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        rate_limit: parseInt(e.target.value) || 100,
                      })
                    }
                    min={100}
                    step={100}
                    className="rounded-none border-white/10 bg-black/60 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800]"
                  />
                </div>
              )}
            </div>
          </div>
          <DialogFooter className="gap-2">
            <BrandButton
              variant="outline"
              onClick={() => setCreateDialogOpen(false)}
              disabled={isCreating}
            >
              Cancel
            </BrandButton>
            <BrandButton
              variant="primary"
              onClick={handleCreateKey}
              disabled={isCreating || !formData.name.trim()}
            >
              {isCreating ? "Creating..." : "Create key"}
            </BrandButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ApiKeysSummary summary={summary} />

      {createdKey && (
        <Dialog open={!!createdKey} onOpenChange={() => setCreatedKey(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>API key created successfully</DialogTitle>
              <DialogDescription>
                Make sure to copy your API key now. You won&apos;t be able to see it again!
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid gap-2">
                <label className="text-xs font-medium text-white/70 uppercase tracking-wide">
                  Key name
                </label>
                <div className="font-mono text-sm font-semibold text-white">{createdKey.name}</div>
              </div>
              <div className="grid gap-2">
                <label className="text-xs font-medium text-white/70 uppercase tracking-wide">
                  API Key
                </label>
                <div className="flex gap-2">
                  <Input
                    value={createdKey.plainKey}
                    readOnly
                    className="font-mono text-sm rounded-none border-white/10 bg-black/40 text-white"
                  />
                  <BrandButton
                    variant="outline"
                    onClick={() => void handleCopyKey(createdKey.plainKey)}
                  >
                    <Copy className="h-4 w-4" />
                  </BrandButton>
                </div>
              </div>
            </div>
            <DialogFooter>
              <BrandButton variant="primary" onClick={() => setCreatedKey(null)}>
                Done
              </BrandButton>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <div className="space-y-6">
        {hasKeys ? (
          <ApiKeysTable
            keys={keys}
            onCopyKey={(id) => void handleCopyStoredKey(id)}
            onDisableKey={handleDisableKey}
            onDeleteKey={handleDeleteKey}
            onRegenerateKey={handleRegenerateKey}
          />
        ) : (
          <ApiKeyEmptyState onCreateKey={() => setCreateDialogOpen(true)} />
        )}
      </div>

      {/* Confirm Action Dialog */}
      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(open) => !open && setPendingAction(null)}
      >
        <AlertDialogContentComp>
          <AlertDialogHeaderComp>
            <AlertDialogTitleComp>{pendingAction?.title}</AlertDialogTitleComp>
            <AlertDialogDescComp>{pendingAction?.description}</AlertDialogDescComp>
          </AlertDialogHeaderComp>
          <AlertDialogFooterComp>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmAction}
              className={pendingAction?.type === "delete" ? "bg-red-600 hover:bg-red-700" : ""}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooterComp>
        </AlertDialogContentComp>
      </AlertDialog>
    </DashboardPageContainer>
  );
}
