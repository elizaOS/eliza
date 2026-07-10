/**
 * ElizaAgentActions — start/stop/deactivate/reactivate/snapshot/upgrade/delete
 * controls on the agent detail page.
 *
 * **Upgrade to Dedicated** (shared-tier agents only, #15355) drives the whole
 * shared→dedicated tier upgrade from this page: a confirm dialog spells out the
 * continuous hosting burn and the server-enforced credit runway, then
 * `POST /upgrade-tier` mints + provisions the dedicated migration target
 * (identity copied server-side) and the handoff module moves the conversation
 * and — only on a confirmed switch — removes the shared bridge before this
 * page navigates to the new agent.
 *
 * **Deactivate** is the user-facing name for the `sleep` lifecycle action
 * (`POST /sleep`): a deep cold suspend that saves a durable encrypted backup,
 * removes the container, and frees the compute slot, so the agent stops
 * consuming hourly credits entirely (the billing cron skips `sleeping` rows).
 * It sits next to Delete as the non-destructive alternative and requires a
 * confirm dialog that spells out the billing consequences. **Reactivate**
 * (`POST /wake`) re-provisions compute and restores the backup — it can take a
 * few minutes, so the tracked-job progress line carries wake-specific copy.
 * Both ride the existing 202 + jobId poll path. Pricing figures shown in the
 * dialog come from the cloud-shared `AGENT_PRICING` constants (the same source
 * the billing cron charges from) — the client only displays them.
 */
"use client";

import { AGENT_PRICING } from "@elizaos/cloud-shared/lib/constants/agent-pricing";
import {
  formatHourlyRate,
  formatUSD,
} from "@elizaos/cloud-shared/lib/constants/agent-pricing-display";
import type { AgentExecutionTier } from "@elizaos/cloud-shared/lib/types/cloud-api";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  BrandButton,
  BrandCard,
} from "@elizaos/ui/cloud-ui";
import {
  Camera,
  ExternalLink,
  Loader2,
  Moon,
  Pause,
  Play,
  Rocket,
  Sun,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ElizaClient } from "../../../api";
import { Button } from "../../../components/ui/button";
import { getBootConfig } from "../../../config/boot-config";
import { runSharedToDedicatedUpgradeHandoff } from "../../handoff/start-tier-upgrade";
import { apiWithStatus, readCloudBearerToken } from "../../lib/api-client";
import { useT } from "../lib/i18n";
import { openWebUIWithPairing } from "../lib/open-web-ui";
import { useJobPoller } from "../lib/use-job-poller";

interface ElizaAgentActionsProps {
  agentId: string;
  executionTier: AgentExecutionTier;
  status: string;
  webUiUrl: string | null;
}

export function ElizaAgentActions({
  agentId,
  executionTier,
  status,
  webUiUrl,
}: ElizaAgentActionsProps) {
  const t = useT();
  const navigate = useNavigate();
  const [loading, setLoading] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showDeactivateConfirm, setShowDeactivateConfirm] = useState(false);
  const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);
  // Set for the whole shared→dedicated upgrade span (provision + transcript
  // move); the id is the dedicated migration target this page navigates to on
  // a confirmed switch.
  const [upgradeTargetId, setUpgradeTargetId] = useState<string | null>(null);
  const jobActionById = useRef(new Map<string, string>());

  const poller = useJobPoller({
    onComplete: (job) => {
      const action = jobActionById.current.get(job.jobId);
      jobActionById.current.delete(job.jobId);
      if (action === "delete") {
        toast.success(
          t("cloud.containers.agentActions.agentDeleted", {
            defaultValue: "Agent deleted",
          }),
        );
        navigate("/dashboard/agents");
        return;
      }
      if (action === "sleep") {
        toast.success(
          t("cloud.containers.agentActions.deactivated", {
            defaultValue: "Agent deactivated — hourly billing stopped",
          }),
        );
        return;
      }
      if (action === "wake") {
        toast.success(
          t("cloud.containers.agentActions.reactivated", {
            defaultValue: "Agent reactivated",
          }),
        );
        return;
      }
      toast.success(
        t("cloud.containers.agentActions.jobCompleted", {
          defaultValue: "{action} completed",
          action: action ?? "Agent job",
        }),
      );
    },
    onFailed: (job) => {
      const action = jobActionById.current.get(job.jobId);
      jobActionById.current.delete(job.jobId);
      toast.error(
        job.error ??
          t("cloud.containers.agentActions.jobFailed", {
            defaultValue: "{action} failed",
            action: action ?? "Agent job",
          }),
      );
    },
  });

  // Progress display for the dedicated migration target's provision job. A
  // SEPARATE poller instance with the hard-reload disabled: the transcript
  // handoff keeps running in this page after the provision job completes, and
  // the default `window.location.reload()` would kill it mid-import.
  const upgradePoller = useJobPoller({ autoRefresh: false });

  const trackedJob = poller.getStatus(agentId);
  const trackedAction = trackedJob
    ? jobActionById.current.get(trackedJob.jobId)
    : undefined;
  const effectiveStatus = poller.isActive(agentId) ? "provisioning" : status;

  const isRunning = effectiveStatus === "running";
  const isSleeping = effectiveStatus === "sleeping";
  const isDedicated = executionTier !== "shared";
  const hasStandaloneWebUi = isRunning && isDedicated && Boolean(webUiUrl);
  // Sleep (deep cold suspend) only applies to dedicated agents with their own
  // compute slot — shared-runtime agents have nothing to free.
  const canSleep = isRunning && isDedicated;
  const canWake = isSleeping;
  // Tier upgrade is a shared-agent-only promotion (#15355); a dedicated agent
  // already runs on its own container.
  const canUpgrade = isRunning && !isDedicated && !upgradeTargetId;
  const upgradeJob = upgradePoller.getStatus(agentId);
  const isStopped = ["stopped", "error", "pending", "disconnected"].includes(
    effectiveStatus,
  );
  const isBusy = effectiveStatus === "provisioning";

  async function doAction(action: string, method = "POST") {
    setLoading(action);
    try {
      let url = `/api/v1/eliza/agents/${agentId}`;
      let json: unknown;

      if (action === "resume") {
        url = `/api/v1/eliza/agents/${agentId}/resume`;
      } else if (action === "provision") {
        url = `/api/v1/eliza/agents/${agentId}/provision`;
      } else if (action === "snapshot") {
        url = `/api/v1/eliza/agents/${agentId}/snapshot`;
      } else if (action === "sleep") {
        url = `/api/v1/eliza/agents/${agentId}/sleep`;
      } else if (action === "wake") {
        url = `/api/v1/eliza/agents/${agentId}/wake`;
      } else if (action === "delete") {
        method = "DELETE";
      } else if (action === "shutdown" || action === "suspend") {
        method = "PATCH";
        json = { action: "suspend" };
      }

      const { status: httpStatus, data } = await apiWithStatus<{
        data?: { jobId?: string };
        error?: string;
      }>(url, { method, json });
      const jobId = data?.data?.jobId;

      // 409 — operation already in flight; attach to the existing job when the
      // backend returned one. Informational, not an error.
      if (httpStatus === 409) {
        if (jobId) {
          jobActionById.current.set(jobId, action);
          poller.track(agentId, jobId);
        }
        toast.info(
          t("cloud.containers.agentActions.actionAlreadyInProgress", {
            defaultValue: "{action} already in progress",
            action,
          }),
        );
        return;
      }

      if (httpStatus < 200 || httpStatus >= 300) {
        throw new Error(data?.error ?? `HTTP ${httpStatus}`);
      }

      // 202 + jobId — the backend enqueued a job; track it.
      if (httpStatus === 202 && jobId) {
        jobActionById.current.set(jobId, action);
        poller.track(agentId, jobId);
        const queuedMessages: Record<string, string> = {
          provision: t("cloud.containers.agentActions.provisioningQueued", {
            defaultValue: "Agent provisioning queued",
          }),
          resume: t("cloud.containers.agentActions.resumeQueued", {
            defaultValue: "Agent resume queued",
          }),
          snapshot: t("cloud.containers.agentActions.snapshotQueued", {
            defaultValue: "Snapshot queued",
          }),
          suspend: t("cloud.containers.agentActions.suspendQueued", {
            defaultValue: "Suspend queued",
          }),
          shutdown: t("cloud.containers.agentActions.suspendQueued", {
            defaultValue: "Suspend queued",
          }),
          sleep: t("cloud.containers.agentActions.deactivateQueued", {
            defaultValue: "Deactivation queued — saving an encrypted backup",
          }),
          wake: t("cloud.containers.agentActions.reactivateQueued", {
            defaultValue:
              "Reactivation queued — restoring from backup (this can take a few minutes)",
          }),
          delete: t("cloud.containers.agentActions.deleteQueued", {
            defaultValue: "Delete queued",
          }),
        };
        toast.success(
          queuedMessages[action] ??
            t("cloud.containers.agentActions.actionQueued", {
              defaultValue: "{action} queued",
              action,
            }),
        );
        return;
      }

      if (action === "delete") {
        toast.success(
          t("cloud.containers.agentActions.agentDeleted", {
            defaultValue: "Agent deleted",
          }),
        );
        navigate("/dashboard/agents");
        return;
      }

      // Fallback: synchronous success (no jobId returned).
      const messages: Record<string, string> = {
        provision: t("cloud.containers.agentActions.provisioningStarted", {
          defaultValue: "Agent provisioning started",
        }),
        resume: t("cloud.containers.agentActions.resumingSnapshot", {
          defaultValue: "Agent resuming from snapshot",
        }),
        snapshot: t("cloud.containers.agentActions.snapshotSaved", {
          defaultValue: "Snapshot saved",
        }),
        suspend: t("cloud.containers.agentActions.suspended", {
          defaultValue: "Agent suspended (snapshot saved)",
        }),
        sleep: t("cloud.containers.agentActions.deactivated", {
          defaultValue: "Agent deactivated — hourly billing stopped",
        }),
        wake: t("cloud.containers.agentActions.reactivated", {
          defaultValue: "Agent reactivated",
        }),
      };
      toast.success(
        messages[action] ??
          t("cloud.containers.agentActions.done", { defaultValue: "Done" }),
      );
      window.location.reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(
        `${t("cloud.containers.agentActions.actionFailed", { defaultValue: "Action failed" })}: ${msg}`,
      );
    } finally {
      setLoading(null);
      setShowDeleteConfirm(false);
      setShowDeactivateConfirm(false);
    }
  }

  /**
   * Shared→dedicated tier upgrade (#15355), end to end from this page:
   * `POST /upgrade-tier` mints + provisions the dedicated migration target
   * (402 = the server's N-days-of-hosting credit gate; a retry reattaches to
   * the same in-flight target instead of minting another), then the handoff
   * module polls readiness, copies the conversation, and — only on a confirmed
   * switch — deletes the shared bridge, after which this page navigates to the
   * dedicated agent. On timeout/failure the shared agent is untouched and the
   * action can simply be retried.
   */
  async function doUpgrade() {
    setLoading("upgrade-tier");
    setShowUpgradeConfirm(false);
    try {
      const { status: httpStatus, data } = await apiWithStatus<{
        data?: { dedicatedAgentId?: string; jobId?: string };
        error?: string;
      }>(`/api/v1/eliza/agents/${agentId}/upgrade-tier`, { method: "POST" });

      if (httpStatus === 402) {
        // The canonical insufficient-credits body carries the real enforced
        // numbers — render the server's message, never client math.
        toast.error(
          data?.error ??
            t("cloud.containers.agentActions.upgradeInsufficientCredits", {
              defaultValue:
                "Not enough credits to upgrade. Add funds at /dashboard/billing and try again.",
            }),
        );
        return;
      }
      if (httpStatus < 200 || httpStatus >= 300) {
        throw new Error(data?.error ?? `HTTP ${httpStatus}`);
      }

      const dedicatedAgentId = data?.data?.dedicatedAgentId;
      if (!dedicatedAgentId) {
        throw new Error("Upgrade did not return a dedicated agent id");
      }
      const jobId = data?.data?.jobId;
      if (jobId) {
        upgradePoller.track(agentId, jobId);
      }
      setUpgradeTargetId(dedicatedAgentId);
      toast.success(
        t("cloud.containers.agentActions.upgradeStarted", {
          defaultValue:
            "Upgrade started — provisioning your dedicated agent. Keep this page open.",
        }),
      );

      const cloudApiBase =
        getBootConfig().cloudApiBase?.trim() || window.location.origin;
      const authToken = readCloudBearerToken();
      if (!authToken) {
        throw new Error(
          "Cloud session token unavailable — reload the page and try again.",
        );
      }
      // The handoff's readiness probe doubles as the provisioning wait (a cold
      // dedicated boot is 30-120s); the visible job line above tracks the
      // provision job itself.
      const outcome = await runSharedToDedicatedUpgradeHandoff({
        sharedAgentId: agentId,
        dedicatedAgentId,
        cloudApiBase,
        authToken,
        client: new ElizaClient(cloudApiBase, authToken),
        intervalMs: 5_000,
        timeoutMs: 10 * 60_000,
      });

      if (
        outcome.status === "switched" ||
        outcome.status === "switched-empty"
      ) {
        toast.success(
          t("cloud.containers.agentActions.upgradeComplete", {
            defaultValue:
              "Upgrade complete — your conversation moved to the dedicated agent.",
          }),
        );
        if (!outcome.sharedBridgeDeleted) {
          // The user is switched either way; a leaked shared row is only a
          // duplicate list entry, so tell them instead of hiding it.
          toast.info(
            t("cloud.containers.agentActions.upgradeSharedLeftBehind", {
              defaultValue:
                "The old shared agent entry could not be removed automatically — you can delete it from your agents list.",
            }),
          );
        }
        navigate(`/dashboard/agents/${dedicatedAgentId}`);
        return;
      }

      setUpgradeTargetId(null);
      toast.error(
        outcome.error ??
          t("cloud.containers.agentActions.upgradeNotReady", {
            defaultValue:
              "The dedicated agent did not become ready in time. Your shared agent keeps working — try the upgrade again to resume it.",
          }),
      );
    } catch (err) {
      setUpgradeTargetId(null);
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(
        `${t("cloud.containers.agentActions.upgradeFailed", { defaultValue: "Upgrade failed" })}: ${msg}`,
      );
    } finally {
      setLoading(null);
    }
  }

  return (
    <BrandCard className="relative" cornerSize="md">
      <div className="relative z-10 space-y-4">
        <div className="flex items-center gap-2 pb-4 border-b border-white/10">
          <span className="inline-block w-2 h-2 rounded-full bg-muted" />
          <h2
            className="text-xl font-normal text-white"
            style={{ fontFamily: "var(--font-roboto-mono)" }}
          >
            {t("cloud.containers.agentActions.title", {
              defaultValue: "Agent Actions",
            })}
          </h2>
        </div>

        {isSleeping && (
          <div
            className="flex items-start gap-3 rounded-sm border border-white/10 bg-white/5 p-3"
            data-testid="agent-deactivated-panel"
          >
            <Moon className="h-4 w-4 shrink-0 mt-0.5 text-white/50" />
            <p
              className="text-sm text-white/60"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              {t("cloud.containers.agentActions.deactivatedPanel", {
                defaultValue:
                  "This agent is deactivated. It is not running and is not consuming hourly credits; its data is kept in an encrypted backup. Reactivation restores the backup and requires available credits.",
              })}
            </p>
          </div>
        )}

        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex flex-wrap gap-3">
            {hasStandaloneWebUi && (
              <BrandButton
                variant="primary"
                size="sm"
                onClick={() => void openWebUIWithPairing(agentId)}
              >
                <ExternalLink className="h-4 w-4" />
                {t("cloud.containers.agentActions.openWebUi", {
                  defaultValue: "Open Web UI",
                })}
              </BrandButton>
            )}

            {canUpgrade && (
              <BrandButton
                variant="primary"
                size="sm"
                onClick={() => setShowUpgradeConfirm(true)}
                disabled={!!loading || isBusy}
                data-testid="agent-upgrade-tier-button"
                title={t("cloud.containers.agentActions.upgradeHint", {
                  defaultValue:
                    "Move this agent to its own always-on container. Your conversation moves with it.",
                })}
              >
                {loading === "upgrade-tier" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Rocket className="h-4 w-4" />
                )}
                {t("cloud.containers.agentActions.upgrade", {
                  defaultValue: "Upgrade to Dedicated",
                })}
              </BrandButton>
            )}

            {isStopped && (
              <BrandButton
                variant="primary"
                size="sm"
                onClick={() => doAction("resume")}
                disabled={!!loading || isBusy}
              >
                {loading === "resume" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                {t("cloud.containers.agentActions.resume", {
                  defaultValue: "Resume Agent",
                })}
              </BrandButton>
            )}

            {canWake && (
              <BrandButton
                variant="primary"
                size="sm"
                onClick={() => doAction("wake")}
                disabled={!!loading || isBusy}
                title={t("cloud.containers.agentActions.reactivateHint", {
                  defaultValue:
                    "Restores the agent from its encrypted backup and starts it again. This can take a few minutes.",
                })}
              >
                {loading === "wake" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sun className="h-4 w-4" />
                )}
                {t("cloud.containers.agentActions.reactivate", {
                  defaultValue: "Reactivate Agent",
                })}
              </BrandButton>
            )}

            {isRunning && (
              <BrandButton
                variant="outline"
                size="sm"
                onClick={() => doAction("snapshot")}
                disabled={!!loading || isBusy}
              >
                {loading === "snapshot" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Camera className="h-4 w-4" />
                )}
                {t("cloud.containers.agentActions.saveSnapshot", {
                  defaultValue: "Save Snapshot",
                })}
              </BrandButton>
            )}

            {isRunning && (
              <BrandButton
                variant="outline"
                size="sm"
                onClick={() => doAction("suspend", "PATCH")}
                disabled={!!loading || isBusy}
              >
                {loading === "suspend" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Pause className="h-4 w-4" />
                )}
                {t("cloud.containers.agentActions.suspend", {
                  defaultValue: "Suspend Agent",
                })}
              </BrandButton>
            )}
          </div>

          <div className="flex flex-wrap gap-2 lg:justify-end">
            {canSleep && (
              <BrandButton
                variant="outline"
                size="sm"
                onClick={() => setShowDeactivateConfirm(true)}
                disabled={!!loading || isBusy}
                title={t("cloud.containers.agentActions.deactivateHint", {
                  defaultValue:
                    "Stops the agent and its hourly billing. Data is kept in an encrypted backup; reactivate anytime.",
                })}
              >
                {loading === "sleep" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Moon className="h-4 w-4" />
                )}
                {t("cloud.containers.agentActions.deactivate", {
                  defaultValue: "Deactivate Agent",
                })}
              </BrandButton>
            )}

            {!showDeleteConfirm ? (
              <BrandButton
                variant="outline"
                size="sm"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={!!loading || isBusy}
                className="text-red-400 border-red-500/30 hover:bg-red-500/10 hover:text-red-300"
              >
                <Trash2 className="h-4 w-4" />
                {t("cloud.containers.agentActions.delete", {
                  defaultValue: "Delete Agent",
                })}
              </BrandButton>
            ) : (
              <div className="flex flex-wrap items-center gap-2 rounded-sm border border-red-500/30 bg-red-950/20 p-3">
                <span
                  className="text-sm text-red-400"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  {t("cloud.containers.agentActions.confirmDelete", {
                    defaultValue: "Confirm delete?",
                  })}
                </span>
                <BrandButton
                  variant="outline"
                  size="sm"
                  onClick={() => doAction("delete", "DELETE")}
                  disabled={!!loading}
                  className="text-red-400 border-red-500/50 hover:bg-red-500/20"
                >
                  {loading === "delete" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : null}
                  {t("cloud.containers.agentActions.yesDelete", {
                    defaultValue: "Yes, delete",
                  })}
                </BrandButton>
                <BrandButton
                  variant="outline"
                  size="sm"
                  onClick={() => setShowDeleteConfirm(false)}
                  className="text-white/60"
                >
                  {t("cloud.containers.agentActions.cancel", {
                    defaultValue: "Cancel",
                  })}
                </BrandButton>
              </div>
            )}
          </div>
        </div>

        {upgradeTargetId && (
          <div className="space-y-1" data-testid="agent-upgrade-progress">
            <p
              className="text-sm text-yellow-400/80 flex items-center gap-2"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("cloud.containers.agentActions.upgradeProgressHint", {
                defaultValue:
                  "Upgrading — provisioning a dedicated agent and moving your conversation onto it. This can take a few minutes; keep this page open.",
              })}
            </p>
            {upgradeJob && (
              <p
                className="text-xs text-white/40"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                {t("cloud.containers.agentActions.jobLabel", {
                  defaultValue: "Job",
                })}{" "}
                {upgradeJob.jobId.slice(0, 8)} • {upgradeJob.status}
              </p>
            )}
          </div>
        )}

        {poller.isActive(agentId) && (
          <div className="space-y-1">
            <p
              className="text-sm text-yellow-400/80 flex items-center gap-2"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              {trackedAction === "delete"
                ? t("cloud.containers.agentActions.deleteHint", {
                    defaultValue:
                      "Agent delete is running. This page will return to Instances when the job finishes.",
                  })
                : trackedAction === "sleep"
                  ? t("cloud.containers.agentActions.deactivateProgressHint", {
                      defaultValue:
                        "Deactivating — saving an encrypted backup and releasing compute. This page will refresh when the job finishes.",
                    })
                  : trackedAction === "wake"
                    ? t(
                        "cloud.containers.agentActions.reactivateProgressHint",
                        {
                          defaultValue:
                            "Reactivating — restoring your agent from its backup. This can take a few minutes; the page will refresh when it finishes.",
                        },
                      )
                    : t("cloud.containers.agentActions.provisioningHint", {
                        defaultValue:
                          "Agent job is running. This page will refresh when the job finishes.",
                      })}
            </p>
            {trackedJob && (
              <p
                className="text-xs text-white/40"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                {t("cloud.containers.agentActions.jobLabel", {
                  defaultValue: "Job",
                })}{" "}
                {trackedJob.jobId.slice(0, 8)} • {trackedJob.status}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Upgrade confirm — the billing consequence (continuous hosting burn +
          the server-enforced runway minimum) is shown BEFORE anything changes.
          Figures come from the cloud-shared AGENT_PRICING constants, the same
          source the billing cron charges and the upgrade-tier gate enforces
          from — the client only displays them. */}
      <AlertDialog
        open={showUpgradeConfirm}
        onOpenChange={setShowUpgradeConfirm}
      >
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-txt-strong">
              {t("cloud.containers.agentActions.upgradeTitle", {
                defaultValue: "Upgrade to a dedicated agent?",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted">
              <span className="block">
                {t("cloud.containers.agentActions.upgradeBody1", {
                  defaultValue:
                    "Your agent moves to its own always-on container. Unlike the shared runtime, dedicated hosting consumes credits continuously — {{daily}}/day ({{rate}}) while running.",
                  daily: formatUSD(AGENT_PRICING.DAILY_RUNNING_COST),
                  rate: formatHourlyRate(AGENT_PRICING.RUNNING_HOURLY_RATE),
                })}
              </span>
              <span className="block mt-2">
                {t("cloud.containers.agentActions.upgradeBody2", {
                  defaultValue:
                    "Upgrading requires a balance above {{minimum}} ({{days}} days of hosting). If your balance is too low the upgrade is refused before anything changes.",
                  minimum: formatUSD(AGENT_PRICING.UPGRADE_MINIMUM_BALANCE),
                  days: String(AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS),
                })}
              </span>
              <span className="block mt-2">
                {t("cloud.containers.agentActions.upgradeBody3", {
                  defaultValue:
                    "Your conversation history moves to the new agent; the shared agent is removed only after the move is confirmed. You can deactivate or delete the dedicated agent anytime to stop the hosting burn.",
                })}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border bg-transparent text-txt hover:bg-surface">
              {t("cloud.containers.agentActions.cancel", {
                defaultValue: "Cancel",
              })}
            </AlertDialogCancel>
            <Button
              type="button"
              disabled={!!loading || isBusy}
              onClick={() => void doUpgrade()}
              data-testid="agent-upgrade-tier-confirm"
            >
              {loading === "upgrade-tier" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="h-4 w-4" />
              )}
              {t("cloud.containers.agentActions.upgradeConfirm", {
                defaultValue: "Yes, upgrade",
              })}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Deactivate confirm — non-destructive counterpart to delete: spells
          out the billing consequence before the sleep job is enqueued. */}
      <AlertDialog
        open={showDeactivateConfirm}
        onOpenChange={setShowDeactivateConfirm}
      >
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-txt-strong">
              {t("cloud.containers.agentActions.deactivateTitle", {
                defaultValue: "Deactivate this agent?",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted">
              <span className="block">
                {t("cloud.containers.agentActions.deactivateBody1", {
                  defaultValue:
                    "Your agent stops running and stops consuming hourly credits (currently {{rate}} while running).",
                  rate: formatHourlyRate(AGENT_PRICING.RUNNING_HOURLY_RATE),
                })}
              </span>
              <span className="block mt-2">
                {t("cloud.containers.agentActions.deactivateBody2", {
                  defaultValue:
                    "Before deactivation, Eliza saves an encrypted backup. If the backup cannot be saved, the agent stays running and billing continues.",
                })}
              </span>
              <span className="block mt-2">
                {t("cloud.containers.agentActions.deactivateBody3", {
                  defaultValue:
                    "Reactivation restores the backup and can take a few minutes; it requires available credits.",
                })}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border bg-transparent text-txt hover:bg-surface">
              {t("cloud.containers.agentActions.cancel", {
                defaultValue: "Cancel",
              })}
            </AlertDialogCancel>
            <Button
              type="button"
              disabled={!!loading || isBusy}
              onClick={() => doAction("sleep")}
            >
              {loading === "sleep" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
              {t("cloud.containers.agentActions.deactivateConfirm", {
                defaultValue: "Yes, deactivate",
              })}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </BrandCard>
  );
}
