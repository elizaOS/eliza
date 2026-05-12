/**
 * APIs settings tab component for managing API keys.
 * Supports creating, viewing, copying, and deleting API keys with visibility toggle.
 *
 * @param props - APIs tab configuration
 * @param props.user - User data with organization information
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
  BrandCard,
  CornerBrackets,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
} from "@elizaos/cloud-ui";
import { Copy, Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { type ClientApiKey, copyApiKeyToClipboard, listClientApiKeys } from "@/lib/client/api-keys";
import type { UserWithOrganizationDto } from "@/types/cloud-api";

interface ApisTabProps {
  user: UserWithOrganizationDto;
}

interface ModalState {
  showCreateModal: boolean;
  showKeyModal: boolean;
  newlyCreatedKey: string | null;
}

interface OperationState {
  loading: boolean;
  creating: boolean;
  deletingKeyId: string | null;
}

interface FormState {
  name: string;
  description: string;
}

export function ApisTab({ user }: ApisTabProps) {
  const [apiKeys, setApiKeys] = useState<ClientApiKey[]>([]);

  const [modalState, setModalState] = useState<ModalState>({
    showCreateModal: false,
    showKeyModal: false,
    newlyCreatedKey: null,
  });

  const [operationState, setOperationState] = useState<OperationState>({
    loading: true,
    creating: false,
    deletingKeyId: null,
  });

  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const [formState, setFormState] = useState<FormState>({
    name: "",
    description: "",
  });

  const updateModal = (updates: Partial<ModalState>) => {
    setModalState((prev) => ({ ...prev, ...updates }));
  };

  const updateOperation = useCallback((updates: Partial<OperationState>) => {
    setOperationState((prev) => ({ ...prev, ...updates }));
  }, []);

  const updateForm = (updates: Partial<FormState>) => {
    setFormState((prev) => ({ ...prev, ...updates }));
  };

  const fetchApiKeys = useCallback(async () => {
    updateOperation({ loading: true });
    const keys = await listClientApiKeys();
    setApiKeys(keys);
    updateOperation({ loading: false });
  }, [updateOperation]);

  useEffect(() => {
    // Use queueMicrotask to defer execution and avoid synchronous setState
    queueMicrotask(() => {
      fetchApiKeys();
    });
  }, [fetchApiKeys]);

  const handleCreateNewKey = () => {
    updateForm({ name: "", description: "" });
    updateModal({ showCreateModal: true });
  };

  const handleCreateSubmit = async () => {
    if (!formState.name.trim()) {
      toast.error("API key name is required");
      return;
    }

    updateOperation({ creating: true });
    const response = await fetch("/api/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: formState.name.trim(),
        description: formState.description.trim() || undefined,
        permissions: [],
        rate_limit: 1000,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to create API key");
    }

    const data = await response.json();

    updateModal({
      newlyCreatedKey: data.plainKey,
      showCreateModal: false,
      showKeyModal: true,
    });

    await fetchApiKeys();

    toast.success("API key created successfully");
    updateOperation({ creating: false });
  };

  const handleCopyFullKey = async () => {
    if (!modalState.newlyCreatedKey) return;

    try {
      await copyApiKeyToClipboard(modalState.newlyCreatedKey);
      toast.success("Full API key copied to clipboard");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to copy API key");
    }
  };

  const handleDeleteKey = async (keyId: string, keyName: string) => {
    setDeleteTarget({ id: keyId, name: keyName });
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    const { id: keyId } = deleteTarget;
    setDeleteTarget(null);

    updateOperation({ deletingKeyId: keyId });

    const response = await fetch(`/api/v1/api-keys/${keyId}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to delete API key");
    }

    setApiKeys(apiKeys.filter((key) => key.id !== keyId));

    toast.success("API key deleted successfully");
    updateOperation({ deletingKeyId: null });
  };

  return (
    <div className="flex flex-col gap-4 md:gap-6 pb-6 md:pb-8">
      {/* API Keys Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-6">
          {/* Header */}
          <div className="flex flex-col md:flex-row items-start md:justify-between gap-4 w-full">
            <div className="flex flex-col gap-2 max-w-[850px]">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
                <h3 className="text-base font-mono text-[#e1e1e1] uppercase">API keys</h3>
              </div>
              <div className="text-xs md:text-sm font-mono text-[#858585] tracking-tight space-y-2">
                <p>You have permission to view and manage all API Keys in this project.</p>
                <p>
                  Do not share your API Key with others or expose it in the browser or other
                  client-side code. To protect your account&apos;s security, Eliza may automatically
                  disable any API Key that has leaked publicly.
                </p>
                <p>
                  View usage per Key on the{" "}
                  <span className="underline cursor-pointer hover:text-white transition-colors">
                    Usage page
                  </span>
                  .
                </p>
              </div>
            </div>

            {/* Create New Key Button */}
            <button
              type="button"
              onClick={handleCreateNewKey}
              className="relative bg-[#e1e1e1] px-4 py-2.5 overflow-hidden hover:bg-white transition-colors flex items-center justify-center gap-2 w-full md:w-auto md:flex-shrink-0"
            >
              <div
                className="absolute inset-0 opacity-20 bg-repeat pointer-events-none"
                style={{
                  backgroundImage: `url(/assets/settings/pattern-6px-flip.png)`,
                  backgroundSize: "2.915576934814453px 2.915576934814453px",
                }}
              />
              <Plus className="relative z-10 h-[18px] w-[18px] text-black flex-shrink-0" />
              <span className="relative z-10 text-black font-mono font-medium text-sm md:text-base whitespace-nowrap">
                Create new secret key
              </span>
            </button>
          </div>

          {/* API Keys Table */}
          <div className="w-full">
            {operationState.loading ? (
              <div className="flex items-center justify-center p-8 border border-brand-surface">
                <Loader2 className="h-6 w-6 animate-spin text-[#FF5800]" />
              </div>
            ) : apiKeys.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-8 border border-brand-surface gap-2">
                <p className="text-sm text-white/60 font-mono">
                  No API keys yet. Create one to get started.
                </p>
              </div>
            ) : (
              <>
                {/* Mobile Card Layout */}
                <div className="md:hidden space-y-4">
                  {apiKeys.map((apiKey) => (
                    <div
                      key={apiKey.id}
                      className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border border-brand-surface p-4 space-y-3"
                    >
                      {/* Name and Permission Badge */}
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <h4 className="text-base font-mono font-semibold text-white">
                            {apiKey.name}
                          </h4>
                          <span className="px-2 py-0.5 bg-[rgba(255,88,0,0.25)] border border-[#FF5800]/40 text-[#FF5800] text-xs font-mono uppercase flex-shrink-0">
                            {apiKey.permissions.length > 0 ? apiKey.permissions.join(", ") : "All"}
                          </span>
                        </div>
                        {apiKey.description && (
                          <p className="text-xs font-mono text-white/40">{apiKey.description}</p>
                        )}
                      </div>

                      {/* Secret Key Prefix */}
                      <div className="space-y-2">
                        <p className="text-xs font-mono text-white/40 uppercase">Secret Key</p>
                        <div className="flex items-center gap-2">
                          <div className="bg-[rgba(255,255,255,0.03)] border border-white/10 px-3 py-2 flex-1">
                            <p className="text-sm font-mono text-white/80 break-all">
                              {apiKey.key_prefix}...
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Info Grid */}
                      <div className="grid grid-cols-2 gap-3 pt-2 border-t border-white/10">
                        <div className="space-y-1">
                          <p className="text-xs font-mono text-white/40 uppercase">Created</p>
                          <p className="text-xs font-mono text-white/80">
                            {new Date(apiKey.created_at).toLocaleDateString("en-US", {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                            })}
                          </p>
                        </div>

                        <div className="space-y-1">
                          <p className="text-xs font-mono text-white/40 uppercase">Last used</p>
                          <p className="text-xs font-mono text-white/80">
                            {apiKey.last_used_at
                              ? new Date(apiKey.last_used_at).toLocaleDateString("en-US", {
                                  year: "numeric",
                                  month: "short",
                                  day: "numeric",
                                })
                              : "Never"}
                          </p>
                        </div>

                        <div className="space-y-1">
                          <p className="text-xs font-mono text-white/40 uppercase">Usage Count</p>
                          <p className="text-xs font-mono text-white/80">
                            {apiKey.usage_count.toLocaleString()}
                          </p>
                        </div>

                        <div className="space-y-1">
                          <p className="text-xs font-mono text-white/40 uppercase">Status</p>
                          <p className="text-xs font-mono text-white/80">
                            {apiKey.is_active ? (
                              <span className="text-green-400">Active</span>
                            ) : (
                              <span className="text-white/40">Inactive</span>
                            )}
                          </p>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2 pt-2 border-t border-white/10">
                        <button
                          type="button"
                          onClick={() => handleDeleteKey(apiKey.id, apiKey.name)}
                          disabled={operationState.deletingKeyId === apiKey.id}
                          className="flex-1 px-4 py-2 border border-[#EB4335]/40 bg-[#EB4335]/10 hover:bg-[#EB4335]/20 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                          {operationState.deletingKeyId === apiKey.id ? (
                            <>
                              <Loader2 className="h-4 w-4 animate-spin text-[#EB4335]" />
                              <span className="text-xs font-mono text-[#EB4335]">Deleting...</span>
                            </>
                          ) : (
                            <>
                              <Trash2 className="h-4 w-4 text-[#EB4335]" />
                              <span className="text-xs font-mono text-[#EB4335]">Delete</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Desktop Table Layout */}
                <div className="hidden md:block w-full space-y-3">
                  {apiKeys.map((apiKey, index) => (
                    <div
                      key={apiKey.id}
                      className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border border-brand-surface hover:bg-[rgba(10,10,10,0.85)] transition-colors"
                    >
                      {/* Main Info Row */}
                      <div className="p-4 flex items-start justify-between gap-6">
                        {/* Left: Name and Key */}
                        <div className="flex-1 min-w-0 space-y-3">
                          {/* Name and Description */}
                          <div>
                            <div className="flex items-center gap-3 mb-1">
                              <h4 className="text-base font-mono font-semibold text-white">
                                {apiKey.name}
                              </h4>
                              <span className="px-2 py-0.5 bg-[rgba(255,88,0,0.25)] border border-[#FF5800]/40 text-[#FF5800] text-xs font-mono uppercase">
                                {apiKey.permissions.length > 0
                                  ? apiKey.permissions.join(", ")
                                  : "All"}
                              </span>
                            </div>
                            {apiKey.description && (
                              <p className="text-xs font-mono text-white/40">
                                {apiKey.description}
                              </p>
                            )}
                          </div>

                          {/* API Key Prefix */}
                          <div className="flex items-center gap-2">
                            <div className="bg-[rgba(255,255,255,0.03)] border border-white/10 px-3 py-2 flex-1">
                              <p className="text-sm font-mono text-white/80">
                                {apiKey.key_prefix}...
                              </p>
                            </div>
                          </div>
                        </div>

                        {/* Right: Metadata and Actions */}
                        <div className="flex items-start gap-6">
                          {/* Metadata */}
                          <div className="flex gap-6">
                            <div className="space-y-1">
                              <p className="text-xs font-mono text-white/40 uppercase">Created</p>
                              <p className="text-xs font-mono text-white/80">
                                {new Date(apiKey.created_at).toLocaleDateString("en-US", {
                                  year: "numeric",
                                  month: "short",
                                  day: "numeric",
                                })}
                              </p>
                            </div>

                            <div className="space-y-1">
                              <p className="text-xs font-mono text-white/40 uppercase">Last Used</p>
                              <p className="text-xs font-mono text-white/80">
                                {apiKey.last_used_at
                                  ? new Date(apiKey.last_used_at).toLocaleDateString("en-US", {
                                      year: "numeric",
                                      month: "short",
                                      day: "numeric",
                                    })
                                  : "Never"}
                              </p>
                            </div>

                            <div className="space-y-1">
                              <p className="text-xs font-mono text-white/40 uppercase">Usage</p>
                              <p className="text-xs font-mono text-white/80">
                                {apiKey.usage_count.toLocaleString()}
                              </p>
                            </div>
                          </div>

                          {/* Delete Action */}
                          <button
                            type="button"
                            onClick={() => handleDeleteKey(apiKey.id, apiKey.name)}
                            disabled={operationState.deletingKeyId === apiKey.id}
                            className="px-3 py-2 border border-[#EB4335]/40 bg-[#EB4335]/10 hover:bg-[#EB4335]/20 transition-colors disabled:opacity-50 group"
                            title="Delete API key"
                          >
                            {operationState.deletingKeyId === apiKey.id ? (
                              <Loader2 className="h-4 w-4 text-[#EB4335] animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4 text-[#EB4335] group-hover:scale-110 transition-transform" />
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </BrandCard>

      {/* Create Key Dialog */}
      <Dialog
        open={modalState.showCreateModal}
        onOpenChange={(open) => !open && updateModal({ showCreateModal: false })}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-mono uppercase">Create API Key</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-white font-mono text-sm">
                Name <span className="text-red-500">*</span>
              </Label>
              <Input
                value={formState.name}
                onChange={(e) => updateForm({ name: e.target.value })}
                placeholder="My API Key"
                className="bg-transparent border-[#303030] text-white"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-white font-mono text-sm">Description (optional)</Label>
              <Textarea
                value={formState.description}
                onChange={(e) => updateForm({ description: e.target.value })}
                placeholder="Used for production deployment"
                className="bg-transparent border-[#303030] text-white min-h-[80px] resize-none"
              />
            </div>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => updateModal({ showCreateModal: false })}
              className="px-4 py-2.5 border border-[#303030] text-white hover:bg-white/5 transition-colors"
              disabled={operationState.creating}
            >
              <span className="font-mono text-sm">Cancel</span>
            </button>
            <button
              type="button"
              onClick={handleCreateSubmit}
              disabled={operationState.creating || !formState.name.trim()}
              className="relative bg-[#e1e1e1] px-4 py-2.5 overflow-hidden hover:bg-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div
                className="absolute inset-0 opacity-20 bg-repeat pointer-events-none"
                style={{
                  backgroundImage: `url(/assets/settings/pattern-6px-flip.png)`,
                  backgroundSize: "2.915576934814453px 2.915576934814453px",
                }}
              />
              <span className="relative z-10 text-black font-mono font-medium text-sm flex items-center justify-center gap-2">
                {operationState.creating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
                    Creating...
                  </>
                ) : (
                  "Create Key"
                )}
              </span>
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Show Full Key Dialog */}
      <Dialog
        open={modalState.showKeyModal && !!modalState.newlyCreatedKey}
        onOpenChange={(open) =>
          !open && updateModal({ showKeyModal: false, newlyCreatedKey: null })
        }
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono uppercase">Save Your API Key</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-[rgba(255,88,0,0.1)] border border-[#FF5800] p-4">
              <p className="text-sm text-[#FF5800] font-mono">
                ⚠️ This is the only time you will see this key. Save it securely.
              </p>
            </div>
            <div className="space-y-2">
              <Label className="text-white font-mono text-sm">API Key</Label>
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="flex-1 bg-[rgba(10,10,10,0.75)] border border-brand-surface p-3">
                  <p className="text-xs sm:text-sm text-white/80 font-mono break-all">
                    {modalState.newlyCreatedKey}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleCopyFullKey}
                  className="px-4 py-2 bg-[#e1e1e1] hover:bg-white transition-colors flex items-center justify-center gap-2"
                  title="Copy to clipboard"
                >
                  <Copy className="h-5 w-5 text-black" />
                  <span className="text-black font-mono text-sm sm:hidden">Copy</span>
                </button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => updateModal({ showKeyModal: false, newlyCreatedKey: null })}
              className="relative bg-[#e1e1e1] px-6 py-3 overflow-hidden hover:bg-white transition-colors"
            >
              <div
                className="absolute inset-0 opacity-20 bg-repeat pointer-events-none"
                style={{
                  backgroundImage: `url(/assets/settings/pattern-6px-flip.png)`,
                  backgroundSize: "2.915576934814453px 2.915576934814453px",
                }}
              />
              <span className="relative z-10 text-black font-mono font-medium text-sm sm:text-base">
                Done
              </span>
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContentComp>
          <AlertDialogHeaderComp>
            <AlertDialogTitleComp>Delete API Key</AlertDialogTitleComp>
            <AlertDialogDescComp>
              Are you sure you want to delete the API key "{deleteTarget?.name}
              "? This action cannot be undone.
            </AlertDialogDescComp>
          </AlertDialogHeaderComp>
          <AlertDialogFooterComp>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooterComp>
        </AlertDialogContentComp>
      </AlertDialog>
    </div>
  );
}
