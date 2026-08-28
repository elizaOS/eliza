/**
 * Detail drawer for a single registry MCP (user-owned or public).
 *
 * Shows the resolved endpoint, an agent MCP-config snippet, the tool list, and
 * (for owners) usage stats. Owner actions wire to the real registry routes:
 * edit (`PUT`), delete (`DELETE`), publish/unpublish (`:mcpId/publish`). The
 * "Test connection" button runs a real probe via {@link testUserMcpConnection}.
 */

import {
  ExternalLink,
  Loader2,
  Pencil,
  Play,
  Puzzle,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { CodeBlock } from "../../components/ui/code-block";
import { CopyButton } from "../../components/ui/copy-button";
import { StatusBadge } from "../../components/ui/status-badge";
import { TextLink } from "../../components/ui/text-link";
import { ApiError } from "../lib/api-client";
import { useCloudT } from "../shell/CloudI18nProvider";
import type { UserMcpRecord } from "./lib/api-types";
import {
  formatCloudCreditUsd,
  formatMcpUsageTotal,
} from "./lib/format-cloud-credit";
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

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpConnectionTestResult | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  const mcp = data?.mcp;
  const isOwner = data?.isOwner ?? false;
  const stats = data?.stats ?? null;
  const endpointUrl = mcp?.endpointUrl ?? "";

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
          <div className="p-8 text-sm text-muted">
            {t("cloud.mcps.loadingDetail", { defaultValue: "Loading MCP..." })}
          </div>
        ) : (
          <>
            <Card
              variant="bottomDivider"
              className="shrink-0 flex items-start justify-between gap-4 p-4 sm:p-6"
            >
              <div className="flex items-start gap-3 min-w-0">
                <Card variant="insetPadded" className="shrink-0">
                  <Puzzle className="size-5 text-accent" />
                </Card>
                <div className="min-w-0">
                  <DrawerTitle className="flex items-center gap-2 flex-wrap">
                    <span className="truncate">{mcp.name}</span>
                    <McpStatusBadge status={mcp.status} />
                    {mcp.x402_enabled && (
                      <Badge variant="vaultAccent">x402</Badge>
                    )}
                  </DrawerTitle>
                  <DrawerDescription className="mt-1">
                    {mcp.description}
                  </DrawerDescription>
                </div>
              </div>
              <DrawerClose asChild>
                <Button variant="ghost" size="icon" aria-label="Close details">
                  <X className="size-5 text-muted" />
                </Button>
              </DrawerClose>
            </Card>

            <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 space-y-6">
              {endpointUrl && (
                <Field
                  label={t("cloud.mcps.endpointTitle", {
                    defaultValue: "MCP Endpoint",
                  })}
                >
                  <div className="flex items-center gap-2">
                    <CodeBlock
                      variant="inline"
                      className="flex-1 p-3 text-sm text-txt overflow-x-auto"
                      value={endpointUrl}
                    />
                    <CopyButton
                      value={endpointUrl}
                      copyLabel="Copy endpoint"
                      copiedLabel="Copied"
                      className="min-h-touch justify-center p-3"
                    />
                  </div>
                </Field>
              )}

              <Field
                label={t("cloud.mcps.configTitle", {
                  defaultValue: "Agent configuration",
                })}
              >
                <CodeBlock value={configSnippet} />
              </Field>

              <Field
                label={`${t("cloud.mcps.toolsTitle", {
                  defaultValue: "Tools",
                })} (${mcp.tools.length})`}
              >
                {mcp.tools.length === 0 ? (
                  <p className="text-sm text-muted">
                    {t("cloud.mcps.noTools", {
                      defaultValue: "No tools defined yet.",
                    })}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {mcp.tools.map((tool) => (
                      <Badge
                        key={tool.name}
                        title={tool.description}
                        variant="outline"
                        size="pill"
                      >
                        {tool.name}
                      </Badge>
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
                        defaultValue: "Total cloud credits charged",
                      })}
                      value={formatMcpUsageTotal(stats)}
                    />
                    <Stat
                      label={t("cloud.mcps.statX402", {
                        defaultValue: "x402 (USD)",
                      })}
                      value={formatCloudCreditUsd(stats.totalX402EarnedUsd)}
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
                  <CodeBlock
                    tone={testResult.ok ? "default" : "destructive"}
                    className="max-h-48"
                    value={testResult.detail}
                  />
                </Field>
              )}
            </div>

            <Card
              variant="topDivider"
              className="shrink-0 flex flex-wrap items-center justify-between gap-3 p-4 sm:p-6"
            >
              <div className="flex flex-wrap items-center gap-2">
                {mcp.documentation_url && (
                  <Button variant="outline" size="sm" asChild>
                    <TextLink
                      href={mcp.documentation_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="size-4" />
                      {t("cloud.mcps.docs", { defaultValue: "Docs" })}
                    </TextLink>
                  </Button>
                )}
                {isOwner && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onEdit(mcp)}
                    >
                      <Pencil className="size-4" />
                      {t("cloud.mcps.edit", { defaultValue: "Edit" })}
                    </Button>
                    {mcp.status === "live" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void doUnpublish()}
                        disabled={unpublish.isPending}
                      >
                        {t("cloud.mcps.unpublish", {
                          defaultValue: "Unpublish",
                        })}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void doPublish()}
                        disabled={publish.isPending}
                      >
                        <Upload className="size-4" />
                        {t("cloud.mcps.publish", { defaultValue: "Publish" })}
                      </Button>
                    )}
                    <Button
                      variant="dangerGhost"
                      size="sm"
                      onClick={() => setConfirmDelete(true)}
                      disabled={del.isPending}
                    >
                      <Trash2 className="size-4" />
                      {t("cloud.mcps.delete", { defaultValue: "Delete" })}
                    </Button>
                  </>
                )}
              </div>
              <Button
                variant="default"
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
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                {t("cloud.mcps.testConnection", {
                  defaultValue: "Test connection",
                })}
              </Button>
            </Card>
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
            <AlertDialogAction asChild>
              <Button variant="destructive" onClick={() => void doDelete()}>
                {t("cloud.mcps.delete", { defaultValue: "Delete" })}
              </Button>
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
      <p className="text-xs uppercase tracking-wider text-muted">{label}</p>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card variant="insetPadded">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold text-txt-strong tabular-nums">
        {value}
      </p>
    </Card>
  );
}

export function McpStatusBadge({
  status,
}: {
  status: UserMcpRecord["status"];
}) {
  const variant =
    status === "live"
      ? "success"
      : status === "suspended" || status === "deprecated"
        ? "danger"
        : "muted";
  return <StatusBadge label={status.replace("_", " ")} variant={variant} />;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Please try again.";
}
