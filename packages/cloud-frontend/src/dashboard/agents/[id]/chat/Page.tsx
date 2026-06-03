import {
  BrandButton,
  DashboardErrorState,
  DashboardLoadingState,
} from "@elizaos/ui";
import { ArrowLeft, ExternalLink, MessageCircle } from "lucide-react";
import { Helmet } from "react-helmet-async";
import { Link, Navigate, useParams } from "react-router-dom";
import { useT } from "@/providers/I18nProvider";
import { openWebUIWithPairing } from "../../../../hooks/open-web-ui";
import { ApiError } from "../../../../lib/api-client";
import { useRequireAuth } from "../../../../lib/auth-hooks";
import { useAgent } from "../../../../lib/data/eliza-agents";

/**
 * In-cloud chat surface for a sandbox agent (container instance).
 *
 * Cloud chat backend boundary: render `<ElizaChatInterface />` here only after
 * there is a room API scoped to this container.
 * Today, `eliza-chat-interface.tsx` is character-room based via the
 * global chat store and `/api/characters/:ref/...` endpoints — there
 * is no equivalent room/message API for sandbox containers, so we
 * cannot stream chat through cloud here without:
 *   1. A bridge-side chat session endpoint on the container
 *      (or proxy through cloud-api into the container's webUiUrl),
 *   2. A container-scoped variant of `chat-store` / `useStreamingMessage`
 *      that targets that endpoint instead of the cloud character API.
 *
 * Until that lands, this page is the explainer surface — it gives
 * the user a single button into the container's own web UI via the
 * pairing flow, and a back-link to admin.
 */
export default function AgentChatPage() {
  const t = useT();
  const session = useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const enabled = session.ready && session.authenticated;
  const query = useAgent(enabled ? id : undefined);

  const titleId = id ? id.slice(0, 8) : "";

  if (!session.ready || (enabled && query.isLoading)) {
    return (
      <>
        <Helmet>
          <title>
            {t("cloud.agents.chat.metaTitleLoading", {
              defaultValue: "Chat {{id}} — Agent",
              id: titleId,
            })}
          </title>
        </Helmet>
        <DashboardLoadingState
          label={t("cloud.agents.chat.loading", {
            defaultValue: "Loading agent",
          })}
        />
      </>
    );
  }

  if (query.error instanceof ApiError && query.error.status === 404) {
    return <Navigate to="/dashboard/agents" replace />;
  }
  if (query.error) {
    const msg =
      query.error instanceof Error
        ? query.error.message
        : t("cloud.agents.chat.errorFailedLoad", {
            defaultValue: "Failed to load agent",
          });
    return <DashboardErrorState message={msg} />;
  }

  const agent = query.data;
  if (!agent) return <Navigate to="/dashboard/agents" replace />;

  const isRunning = agent.status === "running";
  const hasWebUi = !!agent.adminDetails?.webUiUrl;

  return (
    <>
      <Helmet>
        <title>
          {t("cloud.agents.chat.metaTitle", {
            defaultValue: "Chat — {{name}}",
            name: agent.agentName ?? titleId,
          })}
        </title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <div className="max-w-3xl mx-auto space-y-6">
        <Link
          to={`/dashboard/agents/${agent.id}`}
          className="group inline-flex items-center gap-2 text-sm text-white/50 hover:text-white transition-colors"
        >
          <div className="flex items-center justify-center w-7 h-7 bg-black/40 group-hover:bg-white/10 transition-colors">
            <ArrowLeft className="h-3.5 w-3.5" />
          </div>
          <span>
            {t("cloud.agents.chat.backToAgent", {
              defaultValue: "Back to agent",
            })}
          </span>
        </Link>

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 border border-[#FF5800]/25 bg-[#FF5800]/10">
              <MessageCircle className="h-5 w-5 text-[#FF5800]" />
            </div>
            <div className="min-w-0">
              <h1
                className="text-xl font-semibold text-white truncate"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                {t("cloud.agents.chat.titleWithName", {
                  defaultValue: "Chat — {{name}}",
                  name:
                    agent.agentName ??
                    t("cloud.agents.detail.unnamedAgent", {
                      defaultValue: "Unnamed Agent",
                    }),
                })}
              </h1>
              <p className="text-xs text-white/40 font-mono">{agent.id}</p>
            </div>
          </div>
        </div>

        <div className="border border-white/10 bg-black p-6 space-y-4">
          {!isRunning && (
            <div className="border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 text-sm text-yellow-200/80">
              {t("cloud.agents.chat.agentIsStatus", {
                defaultValue: "This agent is",
              })}{" "}
              <span className="font-mono">{agent.status}</span>.{" "}
              {t("cloud.agents.chat.startBeforeChat", {
                defaultValue: "Start the agent before chatting.",
              })}
            </div>
          )}

          <div className="space-y-2">
            <p className="text-sm text-white/80">
              {t("cloud.agents.chat.notWiredUp", {
                defaultValue:
                  "In-cloud chat for sandbox agents is not yet wired up. The container exposes its own chat UI via a pairing token — open it below.",
              })}
            </p>
            <p className="text-xs text-white/40">
              {t("cloud.agents.chat.trackingNote", {
                defaultValue:
                  "Cloud-streamed chat for containers is tracked under",
              })}
              <span className="font-mono"> eliza-cloud-chat-backend</span>
              {t("cloud.agents.chat.trackingNote2", {
                defaultValue:
                  ": it needs a container-side chat endpoint plus a container-scoped chat store before this page can render an inline chat interface.",
              })}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            {hasWebUi && isRunning && (
              <BrandButton
                variant="primary"
                size="sm"
                onClick={() => openWebUIWithPairing(agent.id)}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t("cloud.agents.chat.openWebUi", {
                  defaultValue: "Open agent web UI",
                })}
              </BrandButton>
            )}
            <Link
              to={`/dashboard/agents/${agent.id}`}
              className="inline-flex items-center gap-1.5 h-8 px-3 text-sm font-medium bg-black text-white/80 hover:bg-white hover:text-black transition-colors"
            >
              {t("cloud.agents.chat.viewAdmin", {
                defaultValue: "View agent admin",
              })}
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
