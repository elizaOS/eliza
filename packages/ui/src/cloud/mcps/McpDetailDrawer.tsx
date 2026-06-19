/**
 * Detail drawer for a single registry MCP (user-owned or public).
 *
 * Shows the resolved endpoint, an agent MCP-config snippet, the tool list, and
 * (for owners) usage stats. Owner actions wire to the real registry routes:
 * edit (`PUT`), delete (`DELETE`), publish/unpublish (`:mcpId/publish`). The
 * "Test connection" button runs a real probe via {@link testUserMcpConnection}.
 */

import {
  Check,
  Copy,
  ExternalLink,
  Pencil,
  Play,
  Puzzle,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { BrandButton } from "../../cloud-ui/components/brand/brand-button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "../../cloud-ui/components/drawer";
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
import { Badge } from "../../components/ui/badge";
import { ApiError } from "../lib/api-client";
import { useCloudT } from "../shell/CloudI18nProvider";
import type { UserMcpRecord } from "./lib/api-types";
import {
  useDeleteMcp,
  usePublishMcp,
  useUnpublishMcp,
} from "./lib/mcp-mutations";
import {
  type McpConnectionTestResult,
  testUserMcpConnection,
} from "./lib/test-connection";
import { useUserMcpDetail } from "./lib/use-mcps";

interface McpDetailDrawerProps {
  mcpId: string | null;
  onClose: () => void;
  onEdit: (mcp: UserMcpRecord) => void;
}

export function McpDetailDrawer({
  mcpId,
  onClose,
  onEdit,
}: McpDetailDrawerProps) {
  const t = useCloudT();
  const { data, isLoading } = useUserMcpDetail(mcpId);
  const publish = usePublishMcp();
  const unpublish = useUnpublishMcp();
  const del = useDeleteMcp();

  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpConnectionTestResult | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  const mcp = data?.mcp;
  const isOwner = data?.isOwner ?? false;
  const stats = data?.stats ?? null;
  const endpointUrl = mcp?.endpointUrl ?? "";

  const copyEndpoint = async () => {
    if (!endpointUrl) return;
    await navigator.clipboard.writeText(endpointUrl);
    setCopied(true);
    toast.success(
      t("cloud.mcps.endpointCopied", { defaultValue: "Endpoint URL copied" }),
    );
    setTimeout(() => setCopied(false), 2000);
  };

  const runTest = async () => {
    if (!mcp) return;
    setTesting(true);
    setTestResult(null);
    const result = await testUserMcpConnection(mcp.id);
    setTestResult(result);
    if (result.ok) toast.success(result.summary);
    else toast.error(result.summary);
    setTesting(false);
  };

  const doPublish = async () => {
    if (!mcp) return;
    try {
      const res = await publish.mutateAsync(mcp.id);
      toast.success(
        res.message ??
          t("cloud.mcps.published", { defaultValue: "MCP published" }),
      );
    } catch (error) {
      toast.error(
        t("cloud.mcps.publishFailed", { defaultValue: "Failed to publish" }),
        { description: errorMessage(error) },
      );
    }
  };

  const doUnpublish = async () => {
    if (!mcp) return;
    try {
      const res = await unpublish.mutateAsync(mcp.id);
      toast.success(
        res.message ??
          t("cloud.mcps.unpublished", { defaultValue: "MCP unpublished" }),
      );
    } catch (error) {
      toast.error(
        t("cloud.mcps.unpublishFailed", {
          defaultValue: "Failed to unpublish",
        }),
        { description: errorMessage(error) },
      );
    }
  };

  const doDelete = async () => {
    if (!mcp) return;
    setConfirmDelete(false);
    try {
      await del.mutateAsync(mcp.id);
      toast.success(t("cloud.mcps.deleted", { defaultValue: "MCP deleted" }));
      onClose();
    } catch (error) {
      toast.error(
        t("cloud.mcps.deleteFailed", { defaultValue: "Failed to delete" }),
        { description: errorMessage(error) },
      );
    }
  };

  const configSnippet = mcp
    ? JSON.stringify(
        {
          mcpServers: {
            [mcp.slug]: { type: mcp.transport_type, url: endpointUrl },
          },
        },
        null,
        2,
      )
    : "";

  return (
    <Drawer open={!!mcpId} onOpenChange={(open) => !open && onClose()}>
      <DrawerContent className="max-h-[88vh] flex flex-col">
        {isLoading || !mcp ? (
          <div className="p-8 text-sm text-white/50">
            {t("cloud.mcps.loadingDetail", { defaultValue: "Loading MCP..." })}
          </div>
        ) : (
          <>
            <div className="shrink-0 flex items-start justify-between gap-4 p-4 sm:p-6 border-b border-white/10">
              <div className="flex items-start gap-3 min-w-0">
                <div className="p-2.5 rounded-sm border border-white/10 bg-white/5 shrink-0">
                  <Puzzle className="h-5 w-5 text-accent" />
                </div>
                <div className="min-w-0">
                  <DrawerTitle className="flex items-center gap-2 flex-wrap">
                    <span className="truncate">{mcp.name}</span>
                    <StatusBadge status={mcp.status} />
                    {mcp.x402_enabled && (
                      <span className="px-1.5 py-0.5 text-[10px] rounded-full border border-accent/40 bg-accent/15 text-accent">
                        x402
                      </span>
                    )}
                  </DrawerTitle>
                  <DrawerDescription className="mt-1">
                    {mcp.description}
                  </DrawerDescription>
                </div>
              </div>
              <DrawerClose className="p-2 rounded-sm hover:bg-white/10 transition-colors">
                <X className="h-5 w-5 text-white/50" />
              </DrawerClose>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 space-y-6">
              {endpointUrl && (
                <Field
                  label={t("cloud.mcps.endpointTitle", {
                    defaultValue: "MCP Endpoint",
                  })}
                >
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded-sm border border-white/10 bg-white/5 p-3 font-mono text-sm text-white/80 overflow-x-auto">
                      {endpointUrl}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyEndpoint()}
                      className="p-3 rounded-sm bg-white/5 hover:bg-white/10 transition-colors"
                      aria-label="Copy endpoint"
                    >
                      {copied ? (
                        <Check className="h-4 w-4 text-accent" />
                      ) : (
                        <Copy className="h-4 w-4 text-white/60" />
                      )}
                    </button>
                  </div>
                </Field>
              )}

              <Field
                label={t("cloud.mcps.configTitle", {
                  defaultValue: "Agent configuration",
                })}
              >
                <pre className="rounded-sm border border-white/10 bg-white/5 p-3 font-mono text-xs text-white/70 overflow-x-auto">
                  {configSnippet}
                </pre>
              </Field>

              <Field
                label={`${t("cloud.mcps.toolsTitle", {
                  defaultValue: "Tools",
                })} (${mcp.tools.length})`}
              >
                {mcp.tools.length === 0 ? (
                  <p className="text-sm text-white/40">
                    {t("cloud.mcps.noTools", {
                      defaultValue: "No tools defined yet.",
                    })}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {mcp.tools.map((tool) => (
                      <span
                        key={tool.name}
                        title={tool.description}
                        className="px-2.5 py-1 text-xs rounded-full border border-white/10 bg-white/5 text-white/70"
                      >
                        {tool.name}
                      </span>
                    ))}
                  </div>
                )}
              </Field>

              {isOwner && stats && (
                <Field
                  label={t("cloud.mcps.statsTitle", {
                    defaultValue: "Usage",
                  })}
                >
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Stat
                      label={t("cloud.mcps.statRequests", {
                        defaultValue: "Requests",
                      })}
                      value={stats.totalRequests.toLocaleString()}
                    />
                    <Stat
                      label={t("cloud.mcps.statCredits", {
                        defaultValue: "Credits earned",
                      })}
                      value={stats.totalCreditsEarned.toLocaleString()}
                    />
                    <Stat
                      label={t("cloud.mcps.statX402", {
                        defaultValue: "x402 (USD)",
                      })}
                      value={`$${stats.totalX402EarnedUsd.toFixed(4)}`}
                    />
                    <Stat
                      label={t("cloud.mcps.statUsers", {
                        defaultValue: "Unique users",
                      })}
                      value={stats.uniqueUsers.toLocaleString()}
                    />
                  </div>
                </Field>
              )}

              {testResult && (
                <Field
                  label={t("cloud.mcps.responseTitle", {
                    defaultValue: "Connection test",
                  })}
                >
                  <pre
                    className={`rounded-sm border p-3 font-mono text-xs overflow-x-auto max-h-48 overflow-y-auto ${
                      testResult.ok
                        ? "border-white/10 bg-white/5 text-white/70"
                        : "border-red-500/30 bg-red-500/10 text-red-200"
                    }`}
                  >
                    {testResult.detail}
                  </pre>
                </Field>
              )}
            </div>

            <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 p-4 sm:p-6 border-t border-white/10">
              <div className="flex flex-wrap items-center gap-2">
                {mcp.documentation_url && (
                  <BrandButton variant="outline" size="sm" asChild>
                    <a
                      href={mcp.documentation_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="h-4 w-4" />
                      {t("cloud.mcps.docs", { defaultValue: "Docs" })}
                    </a>
                  </BrandButton>
                )}
                {isOwner && (
                  <>
                    <BrandButton
                      variant="outline"
                      size="sm"
                      onClick={() => onEdit(mcp)}
                    >
                      <Pencil className="h-4 w-4" />
                      {t("cloud.mcps.edit", { defaultValue: "Edit" })}
                    </BrandButton>
                    {mcp.status === "live" ? (
                      <BrandButton
                        variant="outline"
                        size="sm"
                        onClick={() => void doUnpublish()}
                        disabled={unpublish.isPending}
                      >
                        {t("cloud.mcps.unpublish", {
                          defaultValue: "Unpublish",
                        })}
                      </BrandButton>
                    ) : (
                      <BrandButton
                        variant="outline"
                        size="sm"
                        onClick={() => void doPublish()}
                        disabled={publish.isPending}
                      >
                        <Upload className="h-4 w-4" />
                        {t("cloud.mcps.publish", { defaultValue: "Publish" })}
                      </BrandButton>
                    )}
                    <BrandButton
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmDelete(true)}
                      disabled={del.isPending}
                      className="text-red-300 hover:text-red-200 hover:bg-red-500/10"
                    >
                      <Trash2 className="h-4 w-4" />
                      {t("cloud.mcps.delete", { defaultValue: "Delete" })}
                    </BrandButton>
                  </>
                )}
              </div>
              <BrandButton
                variant="primary"
                size="sm"
                onClick={() => void runTest()}
                disabled={testing || mcp.status !== "live"}
                title={
                  mcp.status !== "live"
                    ? t("cloud.mcps.publishToTest", {
                        defaultValue: "Publish the MCP to test the connection.",
                      })
                    : undefined
                }
              >
                {testing ? (
                  <span className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                {t("cloud.mcps.testConnection", {
                  defaultValue: "Test connection",
                })}
              </BrandButton>
            </div>
          </>
        )}
      </DrawerContent>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("cloud.mcps.deleteTitle", { defaultValue: "Delete MCP" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("cloud.mcps.deleteConfirm", {
                defaultValue:
                  "This permanently removes the MCP server. This cannot be undone.",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("cloud.mcps.cancel", { defaultValue: "Cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void doDelete()}
              className="bg-red-600 hover:bg-red-700"
            >
              {t("cloud.mcps.delete", { defaultValue: "Delete" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Drawer>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs uppercase tracking-wider text-white/40">{label}</p>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-white/10 bg-white/5 p-3">
      <p className="text-xs text-white/40">{label}</p>
      <p className="mt-1 text-lg font-semibold text-white">{value}</p>
    </div>
  );
}

export function StatusBadge({ status }: { status: UserMcpRecord["status"] }) {
  const tone =
    status === "live"
      ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
      : status === "suspended" || status === "deprecated"
        ? "border-red-500/30 bg-red-500/15 text-red-300"
        : "border-white/15 bg-white/5 text-white/60";
  return (
    <Badge
      variant="outline"
      className={`text-[10px] px-1.5 py-0 capitalize ${tone}`}
    >
      {status.replace("_", " ")}
    </Badge>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Please try again.";
}
