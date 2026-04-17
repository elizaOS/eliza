import { Button, Card, CardContent, Input, Spinner } from "@elizaos/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../api";
import type {
  CloudCompatAgent,
  CloudCompatJob,
} from "../../api/client-types-cloud";
import {
  addAgentProfile,
  savePersistedActiveServer,
  useApp,
} from "../../state";
import type { StartupEvent } from "../../state/startup-coordinator";

const MONO_FONT = "'Courier New', 'Courier', 'Monaco', monospace";

type Stage =
  | "login"
  | "loading"
  | "agent-list"
  | "creating"
  | "provisioning"
  | "connecting";

interface SplashCloudAgentsProps {
  t: (key: string, values?: Record<string, unknown>) => string;
  onBack: () => void;
  dispatchStartup: (event: StartupEvent) => void;
}

function statusBadge(status: string): { label: string; className: string } {
  switch (status) {
    case "running":
      return { label: "LIVE", className: "bg-ok text-white" };
    case "provisioning":
    case "queued":
      return { label: "STARTING", className: "bg-warn text-black" };
    case "stopped":
    case "suspended":
      return { label: "STOPPED", className: "bg-black/20 text-black/70" };
    case "failed":
      return { label: "FAILED", className: "bg-danger text-white" };
    default:
      return {
        label: status.toUpperCase(),
        className: "bg-black/10 text-black/60",
      };
  }
}

export function SplashCloudAgents({
  t,
  onBack,
  dispatchStartup,
}: SplashCloudAgentsProps) {
  const { elizaCloudConnected, elizaCloudLoginBusy, handleCloudLogin } =
    useApp();

  const [stage, setStage] = useState<Stage>(
    elizaCloudConnected ? "loading" : "login",
  );
  const [agents, setAgents] = useState<CloudCompatAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newAgentName, setNewAgentName] = useState("");
  const [provisionStatus, setProvisionStatus] = useState("");
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup poll on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  // When cloud connection state changes and we're on the login stage, proceed
  useEffect(() => {
    if (elizaCloudConnected && stage === "login") {
      setStage("loading");
    }
  }, [elizaCloudConnected, stage]);

  // Fetch agents when entering loading stage
  useEffect(() => {
    if (stage !== "loading") return;
    let cancelled = false;

    (async () => {
      try {
        const res = await client.getCloudCompatAgents();
        if (cancelled) return;
        if (res.success) {
          setAgents(res.data);
          setStage("agent-list");
        } else {
          setError("Failed to load agents");
          setStage("agent-list");
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load agents");
        setStage("agent-list");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [stage]);

  const handleLogin = useCallback(async () => {
    setError(null);
    await handleCloudLogin();
  }, [handleCloudLogin]);

  const connectToAgent = useCallback(
    (agent: CloudCompatAgent) => {
      setStage("connecting");

      const apiBase = agent.web_ui_url ?? agent.webUiUrl ?? agent.bridge_url;
      savePersistedActiveServer({
        id: `cloud:${agent.agent_id}`,
        kind: "cloud",
        label: agent.agent_name,
        ...(apiBase ? { apiBase } : {}),
      });
      addAgentProfile({
        kind: "cloud",
        label: agent.agent_name,
        cloudAgentId: agent.agent_id,
        apiBase: apiBase ?? undefined,
      });

      if (apiBase) {
        client.setBaseUrl(apiBase);
      }
      dispatchStartup({ type: "SPLASH_CLOUD_SKIP" });
    },
    [dispatchStartup],
  );

  const handleCreate = useCallback(async () => {
    const name = newAgentName.trim();
    if (!name) return;

    setError(null);
    setStage("creating");

    try {
      const createRes = await client.createCloudCompatAgent({
        agentName: name,
      });
      if (!createRes.success || !createRes.data) {
        setError("Failed to create agent");
        setStage("agent-list");
        return;
      }

      const agentId = createRes.data.agentId;
      if (!agentId) {
        setError("Agent created but no ID returned");
        setStage("agent-list");
        return;
      }

      // Provision
      setStage("provisioning");
      setProvisionStatus("Starting provisioning...");
      const provRes = await client.provisionCloudCompatAgent(agentId);
      const jobId = provRes.data?.jobId;

      if (!jobId) {
        // No job needed — agent may already be ready
        setProvisionStatus("Connecting...");
        const agentRes = await client.getCloudCompatAgent(agentId);
        if (agentRes.success) {
          connectToAgent(agentRes.data);
        } else {
          setError("Provisioning completed but agent not found");
          setStage("agent-list");
        }
        return;
      }

      // Poll job status
      pollTimerRef.current = setInterval(async () => {
        try {
          const jobRes = await client.getCloudCompatJobStatus(jobId);
          if (!jobRes.success) return;

          const job: CloudCompatJob = jobRes.data;
          if (job.status === "completed") {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
            setProvisionStatus("Connecting...");
            const agentRes = await client.getCloudCompatAgent(agentId);
            if (agentRes.success) {
              connectToAgent(agentRes.data);
            } else {
              setError("Agent provisioned but not found");
              setStage("agent-list");
            }
          } else if (job.status === "failed") {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
            setError(job.error ?? "Provisioning failed");
            setStage("agent-list");
          } else {
            setProvisionStatus(`Provisioning (${job.status})...`);
          }
        } catch {
          // Transient error — keep polling
        }
      }, 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
      setStage("agent-list");
    }
  }, [newAgentName, connectToAgent]);

  const handleRefresh = useCallback(() => {
    setError(null);
    setStage("loading");
  }, []);

  // ── Login stage ─────────────────────────────────────────────────────
  if (stage === "login") {
    return (
      <div className="mt-4 flex w-full flex-col gap-3 text-left">
        <p
          style={{ fontFamily: MONO_FONT }}
          className="text-3xs uppercase text-black/60"
        >
          {t("startupshell.CloudLogin", {
            defaultValue: "Sign in to Eliza Cloud",
          })}
        </p>
        <Button
          type="button"
          variant="default"
          className="justify-center border-2 border-black bg-black px-3 py-5 text-[#ffe600] font-semibold shadow-md hover:bg-[#ffe600] hover:text-black"
          onClick={handleLogin}
          disabled={elizaCloudLoginBusy}
        >
          {elizaCloudLoginBusy ? (
            <span className="flex items-center gap-2">
              <Spinner className="h-4 w-4" />
              {t("startupshell.WaitingForAuth", {
                defaultValue: "Waiting for auth...",
              })}
            </span>
          ) : (
            t("startupshell.SignInElizaCloud", {
              defaultValue: "Sign in with Eliza Cloud",
            })
          )}
        </Button>
        {error && (
          <p style={{ fontFamily: MONO_FONT }} className="text-3xs text-danger">
            {error}
          </p>
        )}
        <BackButton t={t} onClick={onBack} />
      </div>
    );
  }

  // ── Loading stage ───────────────────────────────────────────────────
  if (stage === "loading") {
    return (
      <div className="mt-4 flex w-full flex-col items-center gap-3">
        <Spinner className="h-6 w-6 text-black/60" />
        <p
          style={{ fontFamily: MONO_FONT }}
          className="text-3xs uppercase text-black/50"
        >
          {t("startupshell.LoadingAgents", {
            defaultValue: "Loading agents...",
          })}
        </p>
      </div>
    );
  }

  // ── Provisioning / Connecting stage ─────────────────────────────────
  if (
    stage === "creating" ||
    stage === "provisioning" ||
    stage === "connecting"
  ) {
    return (
      <div className="mt-4 flex w-full flex-col items-center gap-3">
        <Spinner className="h-6 w-6 text-black/60" />
        <p
          style={{ fontFamily: MONO_FONT }}
          className="text-3xs uppercase text-black/50"
        >
          {stage === "creating"
            ? t("startupshell.CreatingAgent", {
                defaultValue: "Creating agent...",
              })
            : stage === "provisioning"
              ? provisionStatus ||
                t("startupshell.Provisioning", {
                  defaultValue: "Provisioning...",
                })
              : t("startupshell.Connecting", {
                  defaultValue: "Connecting...",
                })}
        </p>
      </div>
    );
  }

  // ── Agent list stage ────────────────────────────────────────────────
  return (
    <div className="mt-4 flex w-full flex-col gap-3 text-left">
      <div className="flex items-center justify-between">
        <p
          style={{ fontFamily: MONO_FONT }}
          className="text-3xs uppercase text-black/60"
        >
          {t("startupshell.YourCloudAgents", {
            defaultValue: "Your cloud agents",
          })}
        </p>
        <button
          type="button"
          onClick={handleRefresh}
          style={{ fontFamily: MONO_FONT }}
          className="text-3xs uppercase text-black/50 hover:text-black underline"
        >
          {t("startupshell.Refresh", { defaultValue: "Refresh" })}
        </button>
      </div>

      {error && (
        <p style={{ fontFamily: MONO_FONT }} className="text-3xs text-danger">
          {error}
        </p>
      )}

      {agents.length > 0 && (
        <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
          {agents.map((agent) => {
            const badge = statusBadge(agent.status);
            return (
              <Card
                key={agent.agent_id}
                className="border-2 border-black bg-white shadow-md"
              >
                <CardContent className="flex items-center justify-between gap-3 px-3 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold text-black">
                        {agent.agent_name}
                      </p>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-3xs font-bold ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </div>
                    {agent.web_ui_url && (
                      <p
                        style={{ fontFamily: MONO_FONT }}
                        className="truncate text-3xs text-black/50"
                      >
                        {agent.web_ui_url}
                      </p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 border-2 border-black bg-white text-black font-semibold hover:bg-black hover:text-[#ffe600]"
                    onClick={() => connectToAgent(agent)}
                    disabled={agent.status === "failed"}
                  >
                    {t("startupshell.Connect", { defaultValue: "Connect" })}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {agents.length === 0 && !error && (
        <p
          style={{ fontFamily: MONO_FONT }}
          className="text-2xs text-black/50 text-center py-2"
        >
          {t("startupshell.NoCloudAgents", {
            defaultValue: "No cloud agents yet",
          })}
        </p>
      )}

      {/* Inline create form */}
      <Card className="border-2 border-dashed border-black/40 bg-white/80">
        <CardContent className="flex items-center gap-2 px-3 py-2.5">
          <Input
            placeholder={t("startupshell.AgentName", {
              defaultValue: "Agent name",
            })}
            value={newAgentName}
            onChange={(e) => setNewAgentName(e.target.value)}
            className="h-8 flex-1 border-black/30 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 border-2 border-black bg-black text-[#ffe600] font-semibold hover:bg-[#ffe600] hover:text-black"
            onClick={handleCreate}
            disabled={!newAgentName.trim()}
          >
            {t("startupshell.CreateAgent", { defaultValue: "Create" })}
          </Button>
        </CardContent>
      </Card>

      <BackButton t={t} onClick={onBack} />
    </div>
  );
}

function BackButton({
  t,
  onClick,
}: {
  t: SplashCloudAgentsProps["t"];
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ fontFamily: MONO_FONT }}
      className="mt-1 text-3xs uppercase text-black/50 hover:text-black underline text-center"
    >
      {t("startupshell.Back", { defaultValue: "Back" })}
    </button>
  );
}
