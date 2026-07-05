/**
 * API keys management view (app-hosted Eliza Cloud surface). Deliberately
 * minimal, Stripe/OpenAI-style: a muted stats line, the keys table (or empty
 * state), a name-only "Generate API key" dialog, the one-time secret-reveal
 * dialog, and a revoke confirmation.
 *
 * Notes:
 * - There is no row-level "copy key" action: the full secret is only ever
 *   shown once, in the post-create reveal dialog. A stored key exposes only
 *   its public prefix, so copying it is pointless.
 * - Create POSTs `{ name }` only — the server owns the rate-limit default
 *   (`createApiKeySchema` in `packages/cloud/api/v1/api-keys/schemas.ts`).
 * - Revoke optimistically removes the row from the `["api-keys"]` cache
 *   because Hyperdrive caches the list GET, so the post-delete refetch can
 *   briefly serve the deleted key; the invalidate reconciles once the cache
 *   expires.
 */

import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { type FormEvent, useCallback, useState } from "react";
import { toast } from "sonner";
import { ApiKeyEmptyState } from "../../cloud-ui/components/api-key-empty-state";
import { BrandButton } from "../../cloud-ui/components/brand/brand-button";
import {
  type ApiKeyDisplay,
  ApiKeysTable,
  formatApiKeyDate,
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
import { CopyButton } from "../../components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { ApiError, apiFetch } from "../lib/api-client";
import { useCloudT } from "../shell/CloudI18nProvider";
import type { ApiKeyRecord } from "./use-api-keys";

interface ApiKeysViewProps {
  keys: ApiKeyDisplay[];
}

interface MutatedApiKeyResponse {
  apiKey: { name: string };
  plainKey: string;
}

/**
 * Real values only, derived from the loaded list: key count, active count, and
 * the newest `createdAt` (null when no key carries a parseable date).
 */
function deriveKeyStats(keys: ApiKeyDisplay[]): {
  total: number;
  active: number;
  lastCreatedAt: string | null;
} {
  let lastCreatedAt: string | null = null;
  let lastCreatedMs = Number.NEGATIVE_INFINITY;
  for (const key of keys) {
    const ms = new Date(key.createdAt).getTime();
    if (!Number.isNaN(ms) && ms > lastCreatedMs) {
      lastCreatedMs = ms;
      lastCreatedAt = key.createdAt;
    }
  }
  return {
    total: keys.length,
    active: keys.filter((key) => key.status === "active").length,
    lastCreatedAt,
  };
}

export function ApiKeysView({ keys }: ApiKeysViewProps) {
  const t = useCloudT();
  const queryClient = useQueryClient();
  const refreshApiKeys = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
  }, [queryClient]);

  const [createOpen, setCreateOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState("");
  const [createdKey, setCreatedKey] = useState<{
    plainKey: string;
    name: string;
  } | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);

  const hasKeys = keys.length > 0;
  const stats = deriveKeyStats(keys);

  useSetPageHeader(
    {
      title: t("cloud.apiKeys.pageTitle", { defaultValue: "API Keys" }),
      // Only surface the header CTA when there is at least one key — the empty
      // state already renders a centred primary create button, and having both
      // visible at once duplicates the action.
      actions: hasKeys ? (
        <BrandButton
          variant="primary"
          size="sm"
          className="gap-2"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4" />
          {t("cloud.apiKeys.createApiKey", { defaultValue: "Generate key" })}
        </BrandButton>
      ) : undefined,
    },
    [hasKeys, t],
  );

  const handleCreateKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || isCreating) return;
    setIsCreating(true);
    try {
      const res = await apiFetch("/api/v1/api-keys", {
        method: "POST",
        json: { name: trimmedName },
      });
      const data = (await res.json()) as MutatedApiKeyResponse;
      // Plaintext secret is only returned on this create response — persist it
      // in local state so it remains visible after the list refetches. The
      // reveal dialog is the success confirmation; no toast.
      setCreatedKey({ plainKey: data.plainKey, name: data.apiKey.name });
      setName("");
      setCreateOpen(false);
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

  const handleRevokeKey = async () => {
    if (!revokeId) return;
    const id = revokeId;
    setRevokeId(null);
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
        t("cloud.apiKeys.deleted", { defaultValue: "API key revoked" }),
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
          defaultValue: "Failed to revoke API key",
        }),
        { description: errorMessage(error) },
      );
    }
  };

  return (
    <DashboardPageContainer className="flex flex-col gap-4 md:gap-6">
      {hasKeys ? (
        <p className="text-sm text-muted">
          {stats.total === 1 ? "1 key" : `${stats.total} keys`}
          {` · ${stats.active} active`}
          {stats.lastCreatedAt
            ? ` · last created ${formatApiKeyDate(stats.lastCreatedAt)}`
            : ""}
        </p>
      ) : null}

      {hasKeys ? (
        <ApiKeysTable keys={keys} onRevokeKey={setRevokeId} />
      ) : (
        <ApiKeyEmptyState onCreateKey={() => setCreateOpen(true)} />
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("cloud.apiKeys.createDialogTitle", {
                defaultValue: "Generate API key",
              })}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={(event) => void handleCreateKey(event)}>
            <div className="grid gap-2">
              <label
                htmlFor="api-key-name"
                className="text-xs font-medium text-txt uppercase tracking-wide"
              >
                {t("cloud.apiKeys.nameLabel", { defaultValue: "Name" })}
              </label>
              <Input
                id="api-key-name"
                placeholder={t("cloud.apiKeys.namePlaceholder", {
                  defaultValue: "Production integration",
                })}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                className="rounded-sm border-border bg-surface text-txt-strong placeholder:text-muted"
              />
            </div>
            <DialogFooter className="mt-6 gap-2">
              <BrandButton
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={isCreating}
              >
                {t("cloud.apiKeys.cancel", { defaultValue: "Cancel" })}
              </BrandButton>
              <BrandButton
                type="submit"
                variant="primary"
                disabled={isCreating || !name.trim()}
              >
                {isCreating
                  ? t("cloud.apiKeys.creating", { defaultValue: "Creating..." })
                  : t("cloud.apiKeys.createKey", {
                      defaultValue: "Generate key",
                    })}
              </BrandButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {createdKey && (
        <Dialog open onOpenChange={(open) => !open && setCreatedKey(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {t("cloud.apiKeys.createdDialogTitle", {
                  name: createdKey.name,
                  defaultValue: "{{name}} created",
                })}
              </DialogTitle>
              <DialogDescription>
                {t("cloud.apiKeys.createdDialogDesc", {
                  defaultValue:
                    "Make sure to copy your API key now. You won't be able to see it again!",
                })}
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <Input
                value={createdKey.plainKey}
                readOnly
                className="rounded-sm border-border bg-surface font-mono text-sm text-txt-strong"
              />
              <CopyButton
                value={createdKey.plainKey}
                feedbackDuration={1500}
                copyLabel={t("cloud.apiKeys.created.copyAria", {
                  defaultValue: "Copy API key",
                })}
                className="h-10 w-10 shrink-0 justify-center rounded-sm border border-border bg-bg-elevated"
              />
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

      <AlertDialog
        open={revokeId !== null}
        onOpenChange={(open) => !open && setRevokeId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("cloud.apiKeys.deleteTitle", {
                defaultValue: "Revoke API key",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("cloud.apiKeys.deleteConfirm", {
                defaultValue:
                  "This key will stop working immediately. This action cannot be undone.",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("cloud.apiKeys.cancel", { defaultValue: "Cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleRevokeKey()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("cloud.apiKeys.confirm", { defaultValue: "Revoke key" })}
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
