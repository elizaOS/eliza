/**
 * Agent detail page (`/cloud/agents/:id`).
 */

import { AGENT_PRICING } from "@elizaos/cloud-shared/lib/constants/agent-pricing";
import {
  formatHourlyRate,
  formatMonthlyEstimate,
} from "@elizaos/cloud-shared/lib/constants/agent-pricing-display";
import {
  Badge,
  DashboardErrorState,
  DashboardLoadingState,
} from "@elizaos/ui/cloud-ui";
import { AlertCircle, ArrowLeft, Cloud } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../lib/api-client";
import { useDocumentTitle } from "../lib/use-document-title";
import { useSessionAuth } from "../lib/use-session-auth";
import { ElizaAgentActions } from "./components/agent-actions";
import { ElizaConnectButton } from "./components/eliza-connect-button";
import { getUserFacingAgentType } from "./lib/agent-type";
import { useAgent } from "./lib/data/eliza-agents";
import { useT } from "./lib/i18n";

export default function AgentDetailPage() {
  const t = useT();
  const session = useSessionAuth();
  const { id } = useParams<{ id: string }>();
  const enabled = session.ready && session.authenticated;
  const query = useAgent(enabled ? id : undefined);

  const titleId = id ? id.slice(0, 8) : "";
  useDocumentTitle(
    t("cloud.agents.detail.metaTitle", {
      defaultValue: "Agent {{id}} — Agents",
      id: titleId,
    }),
  );

  if (!session.ready || (enabled && query.isLoading)) {
    return (
      <DashboardLoadingState
        label={t("cloud.agents.detail.loading", {
          defaultValue: "Loading agent",
        })}
      />
    );
  }

  if (query.error instanceof ApiError && query.error.status === 404) {
    return (
      <div className="mx-auto max-w-prose space-y-4 p-12 text-sm text-muted-strong">
        <h1 className="text-lg font-semibold text-txt-strong">
          {t("cloud.agents.detail.unavailableTitle", {
            defaultValue: "Agent no longer available",
          })}
        </h1>
        <p>
          {t("cloud.agents.detail.unavailableBody", {
            defaultValue:
              "This agent may have been deleted or is no longer available to your account.",
          })}
        </p>
        <Link
          to="/cloud/agents"
          className="inline-flex min-h-touch items-center text-sm font-medium text-accent hover:text-accent-hover transition-colors"
        >
          {t("cloud.agents.detail.returnToAgents", {
            defaultValue: "Return to Agents",
          })}
        </Link>
      </div>
    );
  }
  if (query.error) {
    const msg =
      query.error instanceof Error
        ? query.error.message
        : t("cloud.agents.detail.errorFailedLoad", {
            defaultValue: "Failed to load agent",
          });
    return <DashboardErrorState message={msg} />;
  }

  const agent = query.data;
  if (!agent) {
    return (
      <DashboardErrorState
        message={t("cloud.agents.detail.errorMissingData", {
          defaultValue: "The agent response did not include agent details.",
        })}
      />
    );
  }

  const isRunningish =
    agent.status === "running" || agent.status === "provisioning";
  const isIdle = agent.status === "stopped" || agent.status === "disconnected";
  // Deactivated (sleeping) agents are skipped by the hourly billing cron
  // entirely — show an explicit $0.00/hr instead of a blank so the "stop the
  // burn" promise of deactivation is visible where the burn was shown.
  const isSleeping = agent.status === "sleeping";
  const isShared = agent.executionTier === "shared";
  const showConnect = !!agent.webUiUrl && agent.status === "running";
  const agentType = getUserFacingAgentType(agent.executionTier);
  const agentName = isShared
    ? t("cloud.agents.detail.sharedAgentName", {
        defaultValue: "Shared Agent",
      })
    : (agent.agentName ??
      t("cloud.agents.detail.unnamedAgent", {
        defaultValue: "Unnamed Agent",
      }));

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <Link
          to="/cloud/agents"
          className="group flex min-h-touch items-center gap-2 text-sm text-muted-strong hover:text-txt-strong transition-colors"
        >
          <div className="flex items-center justify-center w-7 h-7 bg-card group-hover:bg-bg-hover transition-colors">
            <ArrowLeft className="h-3.5 w-3.5" />
          </div>
          <span>
            {t("cloud.agents.detail.backToInstances", {
              defaultValue: "Agents",
            })}
          </span>
        </Link>

        <div className="flex items-center gap-2">
          {showConnect && <ElizaConnectButton agentId={agent.id} />}
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-start gap-4">
          <div className="flex items-center justify-center w-12 h-12 border border-accent/25 bg-accent-subtle shrink-0">
            <Cloud className="h-6 w-6 text-accent" />
          </div>
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-2xl font-semibold text-txt-strong truncate font-mono">
                {agentName}
              </h1>
              {!isShared ? (
                <Badge
                  variant="outline"
                  className="text-xs font-medium px-2 py-0.5"
                >
                  {agentType}
                </Badge>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px bg-border border border-border">
        <div className="bg-card p-4 space-y-1">
          <p className="text-xs-tight uppercase tracking-[0.2em] text-muted">
            {t("cloud.agents.detail.statusLabel", { defaultValue: "Status" })}
          </p>
          <p className="text-lg font-medium text-txt-strong capitalize tabular-nums font-mono">
            {agent.status}
          </p>
        </div>
        <div className="bg-card p-4 space-y-1">
          <p className="text-xs-tight uppercase tracking-[0.2em] text-muted">
            {t("cloud.agents.detail.costLabel", { defaultValue: "Cost" })}
          </p>
          <p className="text-lg font-medium text-txt-strong tabular-nums font-mono">
            {isShared
              ? t("cloud.agents.detail.sharedFree", { defaultValue: "Free" })
              : isRunningish
                ? formatHourlyRate(AGENT_PRICING.RUNNING_HOURLY_RATE)
                : isIdle
                  ? formatHourlyRate(AGENT_PRICING.IDLE_HOURLY_RATE)
                  : isSleeping
                    ? formatHourlyRate(0)
                    : "—"}
          </p>
          {!isShared && (isRunningish || isIdle) && (
            <p className="text-2xs text-muted tabular-nums">
              {isRunningish
                ? formatMonthlyEstimate(AGENT_PRICING.RUNNING_HOURLY_RATE)
                : formatMonthlyEstimate(AGENT_PRICING.IDLE_HOURLY_RATE)}
            </p>
          )}
          {!isShared && isSleeping && (
            <p className="text-2xs text-muted">
              {t("cloud.agents.detail.deactivatedNoCost", {
                defaultValue: "Deactivated — no hourly cost",
              })}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-6">
        {agent.errorMessage && (
          <div className="flex items-start gap-3 p-4 bg-destructive-subtle border border-destructive/20">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium text-destructive">
                {t("cloud.agents.detail.agentNeedsAttention", {
                  defaultValue: "This agent needs attention",
                })}
              </p>
              <p className="text-sm text-destructive/70">
                {t("cloud.agents.detail.agentNeedsAttentionBody", {
                  defaultValue:
                    "Try the available lifecycle action again. If the problem continues, contact support.",
                })}
              </p>
            </div>
          </div>
        )}

        {agent.webUiUrl && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="inline-block size-2 bg-accent" />
              <p className="font-mono text-xs-tight uppercase tracking-[0.32em] text-muted-strong">
                {t("cloud.agents.detail.webUi", { defaultValue: "Web UI" })}
              </p>
            </div>

            <div className="border border-border bg-card px-4 py-3 flex items-start gap-3 text-sm">
              <span className="text-xs-tight uppercase tracking-widest text-muted shrink-0 pt-0.5">
                {t("cloud.agents.detail.publicUrl", {
                  defaultValue: "Public URL",
                })}
              </span>
              <a
                href={agent.webUiUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-strong hover:text-txt-strong font-mono text-xs break-all transition-colors"
              >
                {agent.webUiUrl}
              </a>
            </div>
          </section>
        )}

        <ElizaAgentActions
          agentId={agent.id}
          executionTier={agent.executionTier}
          status={agent.status}
          webUiUrl={agent.webUiUrl}
        />
      </div>
    </div>
  );
}
