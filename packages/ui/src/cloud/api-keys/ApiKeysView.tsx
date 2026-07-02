/**
 * API keys management view (app-hosted Eliza Cloud surface). Renders the key
 * summary, table, create dialog with rate-limit presets, the one-time
 * secret-reveal dialog, and the disable/enable/delete/regenerate confirmation
 * flow.
 *
 * Notes:
 * - There is no row-level "copy key" action: the full secret is only ever
 *   shown once, in the post-create reveal dialog (copyable via `handleCopyKey`).
 *   A stored key exposes only its public prefix, so copying it is pointless.
 * - Delete optimistically removes the row from the `["api-keys"]` cache because
 *   Hyperdrive caches the list GET, so the post-delete refetch can briefly
 *   serve the deleted key; the invalidate reconciles once the cache expires.
 */

import { useQueryClient } from "@tanstack/react-query";
import { Copy, Plus } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ApiKeyEmptyState } from "../../cloud-ui/components/api-key-empty-state";
import { BrandButton } from "../../cloud-ui/components/brand/brand-button";
import {
  type ApiKeyDisplay,
  ApiKeysSummary,
  type ApiKeysSummaryData,
  ApiKeysTable,
} from "../../cloud-ui/components/data-list";
import { DashboardPageContainer } from "../../cloud-ui/components/layout/dashboard-page";
import { useSetPageHeader } from "../../cloud-ui/components/layout/page-header-context.hooks";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { ApiError, apiFetch } from "../lib/api-client";
import { useCloudT } from "../shell/CloudI18nProvider";
import { copyApiKeyToClipboard } from "./copy-api-key";
import type { ApiKeyRecord } from "./use-api-keys";

interface ApiKeysViewProps {
  keys: ApiKeyDisplay[];
  summary: ApiKeysSummaryData;
}

interface MutatedApiKeyResponse {
  apiKey: { name: string };
  plainKey: string;
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

type RateLimitPreset = (typeof rateLimitPresets)[number]["value"];

type PendingActionType = "disable" | "delete" | "regenerate";

interface PendingAction {
  type: PendingActionType;
  id: string;
  title: string;
  description: string;
}

export function ApiKeysView({ keys, summary }: ApiKeysViewProps) {
  const t = useCloudT();
  const queryClient = useQueryClient();
  const refreshApiKeys = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
  }, [queryClient]);

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [rateLimitPreset, setRateLimitPreset] =
    useState<RateLimitPreset>("standard");
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
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null,
  );

  const hasKeys = keys.length > 0;

  useSetPageHeader(
    {
      title: t("cloud.apiKeys.pageTitle", { defaultValue: "API Keys" }),
      // Only surface the header CTA when there is at least one key — the empty
      // state already renders a centred primary "Create API Key" button, and
      // having both visible at once duplicates the action.
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

    try {
      const res = await apiFetch("/api/v1/api-keys", {
        method: "POST",
        json: {
          name: formData.name,
          description: formData.description,
          rate_limit: rateLimit,
        },
      });
      const data = (await res.json()) as MutatedApiKeyResponse;

      // Plaintext secret is only returned on this create response — persist it
      // in local state so it remains visible after the list refetches.
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
    } catch (error) {
      toast.error(
        t("cloud.apiKeys.createFailed", {
          defaultValue: "Failed to create API key",
        }),
        { description: errorMessage(error) },
      );
    } finally {
      setIsCreating(false);
    }
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
        { description: errorMessage(error) },
      );
    }
  };

  const handleDisableKey = (id: string) => {
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

  const handleDeleteKey = (id: string) => {
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

  const handleRegenerateKey = (id: string) => {
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
      try {
        await apiFetch(`/api/v1/api-keys/${id}`, {
          method: "PATCH",
          json: { is_active: !isCurrentlyActive },
        });
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
      } catch (error) {
        toast.error(
          isCurrentlyActive
            ? t("cloud.apiKeys.disableFailed", {
                defaultValue: "Failed to disable API key",
              })
            : t("cloud.apiKeys.enableFailed", {
                defaultValue: "Failed to enable API key",
              }),
          { description: errorMessage(error) },
        );
      }
    } else if (type === "delete") {
      try {
        await apiFetch(`/api/v1/api-keys/${id}`, { method: "DELETE" });
        // Hyperdrive caches the list GET, so an immediate refetch can still
        // serve the just-deleted row. Optimistically drop it from every cached
        // `["api-keys", ...]` query (the key is partitioned per user, so match
        // on the prefix) so it disappears immediately.
        queryClient.setQueriesData<ApiKeyRecord[]>(
          { queryKey: ["api-keys"] },
          (existing) => existing?.filter((key) => key.id !== id),
        );
        toast.success(
          t("cloud.apiKeys.deleted", { defaultValue: "API key deleted" }),
          {
            description: t("cloud.apiKeys.deletedDesc", {
              defaultValue: "The API key has been permanently deleted.",
            }),
          },
        );
        // Mark the list stale WITHOUT an immediate refetch: refetching now would
        // re-read the Hyperdrive-cached GET and clobber the optimistic removal
        // above, making the deleted row reappear. It reconciles on the next
        // natural refetch (mount/focus), by which point the cache has rolled over.
        void queryClient.invalidateQueries({
          queryKey: ["api-keys"],
          refetchType: "none",
        });
      } catch (error) {
        toast.error(
          t("cloud.apiKeys.deleteFailed", {
            defaultValue: "Failed to delete API key",
          }),
          { description: errorMessage(error) },
        );
      }
    } else {
      try {
        const res = await apiFetch(`/api/v1/api-keys/${id}/regenerate`, {
          method: "POST",
        });
        const data = (await res.json()) as MutatedApiKeyResponse;
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
      } catch (error) {
        toast.error(
          t("cloud.apiKeys.regenerateFailed", {
            defaultValue: "Failed to regenerate API key",
          }),
          { description: errorMessage(error) },
        );
      }
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
                className="rounded-sm border-white/10 bg-black/40 text-white placeholder:text-white/40   "
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
                className="rounded-sm border-white/10 bg-black/40 text-white placeholder:text-white/40   "
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
                  setRateLimitPreset(value as RateLimitPreset)
                }
              >
                <SelectTrigger className="rounded-sm border-white/10 bg-black/40 text-white  ">
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
                      className="rounded-sm text-white hover:bg-white/10 "
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
                    value={formData.rate_limit}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        rate_limit: Number.parseInt(e.target.value, 10) || 100,
                      })
                    }
                    min={100}
                    step={100}
                    className="rounded-sm border-white/10 bg-black/60 text-white placeholder:text-white/40   "
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
              onClick={() => void handleCreateKey()}
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
            onDisableKey={handleDisableKey}
            onDeleteKey={handleDeleteKey}
            onRegenerateKey={handleRegenerateKey}
          />
        ) : (
          <ApiKeyEmptyState onCreateKey={() => setCreateDialogOpen(true)} />
        )}
      </div>

      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(open) => !open && setPendingAction(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingAction?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("cloud.apiKeys.cancel", { defaultValue: "Cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleConfirmAction()}
              className={
                pendingAction?.type === "delete"
                  ? "bg-red-600 hover:bg-red-700"
                  : ""
              }
            >
              {t("cloud.apiKeys.confirm", { defaultValue: "Confirm" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardPageContainer>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Please try again.";
}
