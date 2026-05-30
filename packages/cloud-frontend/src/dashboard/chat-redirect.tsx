import { DashboardLoadingState } from "@elizaos/ui";
import { MessageCircle, Plus } from "lucide-react";
import { Helmet } from "react-helmet-async";
import { Link, Navigate } from "react-router-dom";
import { useT } from "@/providers/I18nProvider";
import { useRequireAuth } from "../lib/auth-hooks";
import { useAgents } from "../lib/data/eliza-agents";

/**
 * Smart redirect for `/dashboard/chat`.
 *
 * - If the user has at least one running agent, jump to its in-cloud chat
 *   route (`/dashboard/agents/:id/chat`). Most recent activity wins.
 * - Otherwise, render an empty state with a CTA to create one.
 */
export default function DashboardChatRedirectPage() {
  const t = useT();
  const session = useRequireAuth();
  const enabled = session.ready && session.authenticated;
  const query = useAgents();

  if (!session.ready || (enabled && query.isLoading)) {
    return (
      <>
        <Helmet>
          <title>
            {t("cloud.chatRedirect.metaTitle", {
              defaultValue: "Chat — Eliza Cloud",
            })}
          </title>
        </Helmet>
        <DashboardLoadingState
          label={t("cloud.chatRedirect.loading", {
            defaultValue: "Loading agents",
          })}
        />
      </>
    );
  }

  const agents = query.data ?? [];
  const running = agents
    .filter((agent) => agent.status === "running")
    .sort((a, b) => {
      const aTs = a.lastHeartbeatAt
        ? new Date(a.lastHeartbeatAt).getTime()
        : new Date(a.updatedAt).getTime();
      const bTs = b.lastHeartbeatAt
        ? new Date(b.lastHeartbeatAt).getTime()
        : new Date(b.updatedAt).getTime();
      return bTs - aTs;
    });

  const target = running[0];
  if (target) {
    return <Navigate to={`/dashboard/agents/${target.id}/chat`} replace />;
  }

  return (
    <>
      <Helmet>
        <title>
          {t("cloud.chatRedirect.metaTitle", {
            defaultValue: "Chat — Eliza Cloud",
          })}
        </title>
      </Helmet>
      <div className="max-w-xl mx-auto py-16 text-center space-y-5">
        <div className="inline-flex items-center justify-center w-12 h-12 border border-white/10 bg-black/40 mx-auto">
          <MessageCircle className="h-5 w-5 text-white/50" />
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-white">
            {t("cloud.chatRedirect.emptyTitle", {
              defaultValue: "No running agents",
            })}
          </h1>
          <p className="text-sm text-white/55">
            {t("cloud.chatRedirect.emptyBody", {
              defaultValue:
                "Spin up an agent to start chatting. Once it's running, this page will jump you straight into its chat.",
            })}
          </p>
        </div>
        <div className="flex items-center justify-center gap-2">
          <Link
            to="/dashboard/agents"
            className="inline-flex items-center gap-1.5 h-9 px-3 text-sm font-medium bg-[#FF5800] text-black hover:bg-[#e54f00] transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("cloud.chatRedirect.createAgent", {
              defaultValue: "Create an agent",
            })}
          </Link>
        </div>
      </div>
    </>
  );
}
