/**
 * API keys page client component for managing API keys.
 * Displays key summary, table, and creation dialog with rate limit configuration.
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
  ApiKeysSummary,
  ApiKeysTable,
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
} from "@elizaos/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  copyApiKeyToClipboard,
  getClientApiKeySecret,
} from "@/lib/client/api-keys";
import { useT } from "@/providers/I18nProvider";
import type { ApiKeyDisplay, ApiKeysSummaryData } from "./types";

interface ApiKeysPageClientProps {
  keys: ApiKeyDisplay[];
  summary: ApiKeysSummaryData;
}

const rateLimitPresets = [
  {
    value: "standard",
    labelKey: "cloud.apiKeys.rateLimitStandard",
    defaultLabel: "Standard - 1,000 req/min",
  },
  {
    value: "high",
    labelKey: "cloud.apiKeys.rateLimitHigh",
    defaultLabel: "High throughput - 5,000 req/min",
  },
  {
    value: "custom",
    labelKey: "cloud.apiKeys.rateLimitCustom",
    defaultLabel: "Custom",
  },
] as const;

export function ApiKeysPageClient({ keys, summary }: ApiKeysPageClientProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const refreshApiKeys = () => {
    void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
  };
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [rateLimitPreset, setRateLimitPreset] =
    useState<(typeof rateLimitPresets)[number]["value"]>("standard");
  const [isCreating, setIsCreating] = useState(false);
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

  useSetPageHeader(
    {
      title: t("cloud.apiKeys.pageTitle", { defaultValue: "API Keys" }),
      // Only surface the header CTA when there is at least one key — the
      // empty state already renders a centred primary "Create API Key"
      // button, and having both visible at once duplicates the action.
      actions: hasKeys ? (
        <BrandButton
          variant="primary"
          size="sm"
          className="gap-2"
          onClick={() => setCreateDialogOpen(true)}
        >
          <Plus className="h-4 w-4" />
          {t("cloud.apiKeys.createApiKey", { defaultValue: "Create API Key" })}
        </BrandButton>
      ) : undefined,
    },
    [hasKeys, t],
  );

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
        rate_limit: rateLimit,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
          t("cloud.apiKeys.createFailed", {
            defaultValue: "Failed to create API key",
          }),
      );
    }

    // Plaintext secret is only returned on this create response — persist it in
    // local state so it remains visible after the list refetches.
    setCreatedKey({ plainKey: data.plainKey, name: data.apiKey.name });
    setFormData({ name: "", description: "", rate_limit: 1000 });
    setRateLimitPreset("standard");
    setCreateDialogOpen(false);
    toast.success(
      t("cloud.apiKeys.createdSuccess", {
        defaultValue: "API key created successfully",
      }),
      {
        description: t("cloud.apiKeys.createdSuccessDesc", {
          name: data.apiKey.name,
          defaultValue: "{{name}} has been created and is ready to use.",
        }),
      },
    );
    refreshApiKeys();
    setIsCreating(false);
  };

  const handleCopyKey = async (plainKey: string) => {
    try {
      await copyApiKeyToClipboard(plainKey);
      toast.success(
        t("cloud.apiKeys.copied", { defaultValue: "Copied to clipboard" }),
        {
          description: t("cloud.apiKeys.copiedDesc", {
            defaultValue: "Full API key copied to your clipboard.",
          }),
        },
      );
    } catch (error) {
      toast.error(
        t("cloud.apiKeys.copyFailed", {
          defaultValue: "Failed to copy API key",
        }),
        {
          description:
            error instanceof Error
              ? error.message
              : t("cloud.apiKeys.clipboardBlocked", {
                  defaultValue: "Clipboard access was blocked.",
                }),
        },
      );
    }
  };

  const handleCopyStoredKey = async (id: string) => {
    try {
      const plainKey = await getClientApiKeySecret(id);
      await handleCopyKey(plainKey);
    } catch (error) {
      toast.error(
        t("cloud.apiKeys.loadFailed", {
          defaultValue: "Failed to load API key",
        }),
        {
          description:
            error instanceof Error
              ? error.message
              : t("cloud.apiKeys.tryAgain", {
                  defaultValue: "Please try again.",
                }),
        },
      );
    }
  };

  const handleDisableKey = async (id: string) => {
    const key = keys.find((k) => k.id === id);
    const isCurrentlyActive = key?.status === "active";

    setPendingAction({
      type: "disable",
      id,
      title: isCurrentlyActive
        ? t("cloud.apiKeys.disableTitle", { defaultValue: "Disable API Key" })
        : t("cloud.apiKeys.enableTitle", { defaultValue: "Enable API Key" }),
      description: isCurrentlyActive
        ? t("cloud.apiKeys.disableConfirm", {
            defaultValue: "Are you sure you want to disable this API key?",
          })
        : t("cloud.apiKeys.enableConfirm", {
            defaultValue: "Are you sure you want to enable this API key?",
          }),
    });
  };

  const handleDeleteKey = async (id: string) => {
    setPendingAction({
      type: "delete",
      id,
      title: t("cloud.apiKeys.deleteTitle", { defaultValue: "Delete API Key" }),
      description: t("cloud.apiKeys.deleteConfirm", {
        defaultValue:
          "Are you sure you want to delete this API key? This action cannot be undone.",
      }),
    });
  };

  const handleRegenerateKey = async (id: string) => {
    setPendingAction({
      type: "regenerate",
      id,
      title: t("cloud.apiKeys.regenerateTitle", {
        defaultValue: "Regenerate API Key",
      }),
      description: t("cloud.apiKeys.regenerateConfirm", {
        defaultValue:
          "Are you sure you want to regenerate this API key? The old key will stop working immediately.",
      }),
    });
  };

  const handleConfirmAction = async () => {
    if (!pendingAction) return;
    const { type, id } = pendingAction;
    setPendingAction(null);

    if (type === "disable") {
      const key = keys.find((k) => k.id === id);
      const isCurrentlyActive = key?.status === "active";

      const response = await fetch(`/api/v1/api-keys/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !isCurrentlyActive }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(
          data.error ||
            (isCurrentlyActive
              ? t("cloud.apiKeys.disableFailed", {
                  defaultValue: "Failed to disable API key",
                })
              : t("cloud.apiKeys.enableFailed", {
                  defaultValue: "Failed to enable API key",
                })),
        );
      }

      toast.success(
        isCurrentlyActive
          ? t("cloud.apiKeys.disabled", { defaultValue: "API key disabled" })
          : t("cloud.apiKeys.enabled", { defaultValue: "API key enabled" }),
        {
          description: isCurrentlyActive
            ? t("cloud.apiKeys.disabledDesc", {
                defaultValue: "The API key has been disabled successfully.",
              })
            : t("cloud.apiKeys.enabledDesc", {
                defaultValue: "The API key has been enabled successfully.",
              }),
        },
      );
      refreshApiKeys();
    } else if (type === "delete") {
      const response = await fetch(`/api/v1/api-keys/${id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(
          data.error ||
            t("cloud.apiKeys.deleteFailed", {
              defaultValue: "Failed to delete API key",
            }),
        );
      }

      toast.success(
        t("cloud.apiKeys.deleted", { defaultValue: "API key deleted" }),
        {
          description: t("cloud.apiKeys.deletedDesc", {
            defaultValue: "The API key has been permanently deleted.",
          }),
        },
      );
      refreshApiKeys();
    } else if (type === "regenerate") {
      const response = await fetch(`/api/v1/api-keys/${id}/regenerate`, {
        method: "POST",
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
            t("cloud.apiKeys.regenerateFailed", {
              defaultValue: "Failed to regenerate API key",
            }),
        );
      }

      // Same as create: plaintext is only returned now — keep it on screen
      // and refetch the list separately.
      setCreatedKey({ plainKey: data.plainKey, name: data.apiKey.name });
      toast.success(
        t("cloud.apiKeys.regenerated", {
          defaultValue: "API key regenerated",
        }),
        {
          description: t("cloud.apiKeys.regeneratedDesc", {
            name: data.apiKey.name,
            defaultValue:
              "{{name}} has been regenerated. The old key is no longer valid.",
          }),
        },
      );
      refreshApiKeys();
    }
  };

  return (
    <DashboardPageContainer className="flex flex-col gap-6 md:gap-8">
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t("cloud.apiKeys.createDialogTitle", {
                defaultValue: "Create API key",
              })}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-6">
            <div className="grid gap-2">
              <label
                htmlFor="api-key-name"
                className="text-xs font-medium text-white/70 uppercase tracking-wide"
              >
                {t("cloud.apiKeys.nameLabel", { defaultValue: "Name" })}
              </label>
              <Input
                id="api-key-name"
                placeholder={t("cloud.apiKeys.namePlaceholder", {
                  defaultValue: "Production integration",
                })}
                value={formData.name}
                onChange={(e) =>
                  setFormData({ ...formData, name: e.target.value })
                }
                autoFocus
                className="rounded-sm border-white/10 bg-black/40 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800]"
              />
            </div>

            <div className="grid gap-2">
              <label
                htmlFor="api-key-description"
                className="text-xs font-medium text-white/70 uppercase tracking-wide"
              >
                {t("cloud.apiKeys.descriptionLabel", {
                  defaultValue: "Description",
                })}
              </label>
              <Textarea
                id="api-key-description"
                placeholder={t("cloud.apiKeys.descriptionPlaceholder", {
                  defaultValue:
                    "Used by our backend services for customer facing features",
                })}
                value={formData.description}
                onChange={(e) =>
                  setFormData({ ...formData, description: e.target.value })
                }
                rows={3}
                className="rounded-sm border-white/10 bg-black/40 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800]"
              />
            </div>

            <div className="grid gap-2">
              <p className="text-xs font-medium text-white/70 uppercase tracking-wide">
                {t("cloud.apiKeys.rateLimitLabel", {
                  defaultValue: "Rate limit",
                })}
              </p>
              <Select
                value={rateLimitPreset}
                onValueChange={(value) =>
                  setRateLimitPreset(
                    value as (typeof rateLimitPresets)[number]["value"],
                  )
                }
              >
                <SelectTrigger className="rounded-sm border-white/10 bg-black/40 text-white focus:ring-1 focus:ring-[#FF5800]">
                  <SelectValue
                    placeholder={t("cloud.apiKeys.selectLimit", {
                      defaultValue: "Select a limit",
                    })}
                  />
                </SelectTrigger>
                <SelectContent className="rounded-sm border-white/10 bg-black/90">
                  {rateLimitPresets.map((preset) => (
                    <SelectItem
                      key={preset.value}
                      value={preset.value}
                      className="rounded-sm text-white hover:bg-white/10 focus:bg-white/10"
                    >
                      {t(preset.labelKey, {
                        defaultValue: preset.defaultLabel,
                      })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {rateLimitPreset === "custom" && (
                <div className="grid gap-2 rounded-sm border border-dashed border-white/10 bg-black/40 p-4">
                  <label
                    htmlFor="api-key-rate-custom"
                    className="text-xs font-medium text-white/70 uppercase tracking-wide"
                  >
                    {t("cloud.apiKeys.customRateLabel", {
                      defaultValue: "Custom requests / minute",
                    })}
                  </label>
                  <Input
                    id="api-key-rate-custom"
                    type="number"
                    placeholder={t("cloud.apiKeys.customRatePlaceholder", {
                      defaultValue: "Enter custom rate limit",
                    })}
                    value={
                      rateLimitPreset === "custom" ? formData.rate_limit : ""
                    }
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        rate_limit: parseInt(e.target.value, 10) || 100,
                      })
                    }
                    min={100}
                    step={100}
                    className="rounded-sm border-white/10 bg-black/60 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800]"
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
              {t("cloud.apiKeys.cancel", { defaultValue: "Cancel" })}
            </BrandButton>
            <BrandButton
              variant="primary"
              onClick={handleCreateKey}
              disabled={isCreating || !formData.name.trim()}
            >
              {isCreating
                ? t("cloud.apiKeys.creating", { defaultValue: "Creating..." })
                : t("cloud.apiKeys.createKey", { defaultValue: "Create key" })}
            </BrandButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ApiKeysSummary summary={summary} />

      {createdKey && (
        <Dialog open={!!createdKey} onOpenChange={() => setCreatedKey(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {t("cloud.apiKeys.createdDialogTitle", {
                  defaultValue: "API key created successfully",
                })}
              </DialogTitle>
              <DialogDescription>
                {t("cloud.apiKeys.createdDialogDesc", {
                  defaultValue:
                    "Make sure to copy your API key now. You won't be able to see it again!",
                })}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid gap-2">
                <p className="text-xs font-medium text-white/70 uppercase tracking-wide">
                  {t("cloud.apiKeys.keyName", { defaultValue: "Key name" })}
                </p>
                <div className="font-mono text-sm font-semibold text-white">
                  {createdKey.name}
                </div>
              </div>
              <div className="grid gap-2">
                <p className="text-xs font-medium text-white/70 uppercase tracking-wide">
                  {t("cloud.apiKeys.apiKeyLabel", { defaultValue: "API Key" })}
                </p>
                <div className="flex gap-2">
                  <Input
                    value={createdKey.plainKey}
                    readOnly
                    className="font-mono text-sm rounded-sm border-white/10 bg-black/40 text-white"
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
              <BrandButton
                variant="primary"
                onClick={() => setCreatedKey(null)}
              >
                {t("cloud.apiKeys.done", { defaultValue: "Done" })}
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
            <AlertDialogDescComp>
              {pendingAction?.description}
            </AlertDialogDescComp>
          </AlertDialogHeaderComp>
          <AlertDialogFooterComp>
            <AlertDialogCancel>
              {t("cloud.apiKeys.cancel", { defaultValue: "Cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmAction}
              className={
                pendingAction?.type === "delete"
                  ? "bg-red-600 hover:bg-red-700"
                  : ""
              }
            >
              {t("cloud.apiKeys.confirm", { defaultValue: "Confirm" })}
            </AlertDialogAction>
          </AlertDialogFooterComp>
        </AlertDialogContentComp>
      </AlertDialog>
    </DashboardPageContainer>
  );
}
