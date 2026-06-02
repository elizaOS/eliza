import { Button, dispatchFocusConnector, useApp } from "@elizaos/ui";
import { Loader2, RefreshCw, Settings, Sparkles } from "lucide-react";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import type { ReactNode } from "react";
import { useCallback } from "react";
import { useLifeOpsXConnector } from "../hooks/useLifeOpsXConnector.js";

function readXIdentity(
  identity: Record<string, unknown> | null,
  fallback: string,
): string {
  if (!identity) {
    return fallback;
  }
  const keys = ["name", "username", "screen_name", "handle"] as const;
  for (const key of keys) {
    const value = identity[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  const identifier = identity.id;
  return typeof identifier === "string" && identifier.trim().length > 0
    ? identifier.trim()
    : fallback;
}

function PanelShell({
  title,
  icon,
  status,
  children,
}: {
  title: string;
  icon: ReactNode;
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-3xl border border-border/16 bg-card/18 px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {icon}
          <div className="truncate text-sm font-semibold text-txt">{title}</div>
        </div>
        {status}
      </div>
      {children}
    </section>
  );
}

function StatusDot({
  connected,
  label,
}: {
  connected: boolean;
  label: string;
}) {
  return (
    <span
      aria-label={label}
      className={`inline-block h-2.5 w-2.5 rounded-full ${
        connected
          ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.14)]"
          : "bg-muted/45"
      }`}
      role="img"
      title={label}
    />
  );
}

export function LifeOpsXPanel() {
  const { setActionNotice, setTab, t } = useApp();
  const ownerX = useLifeOpsXConnector("owner");
  const agentX = useLifeOpsXConnector("agent");
  const status = ownerX.status;
  const agentStatus = agentX.status;
  const connected = status?.connected === true;
  const agentConnected = agentStatus?.connected === true;
  const ownerIdentity = readXIdentity(status?.identity ?? null, "");
  const agentIdentity = readXIdentity(agentStatus?.identity ?? null, "");

  const openXConnectorSettings = useCallback(() => {
    setTab("connectors");
    dispatchFocusConnector("x");
    setActionNotice(
      "X account setup is managed in Connectors. Configure plugin-x there, then refresh LifeOps.",
      "info",
      4200,
    );
  }, [setActionNotice, setTab]);

  const refreshLabel = t("common.refresh", { defaultValue: "Refresh" });
  const refreshX = useAgentElement<HTMLButtonElement>({
    id: "settings-x-refresh",
    role: "button",
    label: refreshLabel,
    group: "lifeops-x",
    description: "Refresh owner and agent X connection status",
  });
  const setupLabel = t("lifeopspanels.openXConnectorSettings", {
    defaultValue: "Open X connector settings",
  });
  const openConnector = useAgentElement<HTMLButtonElement>({
    id: "settings-x-open-connector",
    role: "button",
    label: setupLabel,
    group: "lifeops-x",
    description: "Open plugin-x connector setup",
  });

  return (
    <PanelShell
      title={t("lifeopspanels.xAccount", { defaultValue: "X" })}
      icon={<Sparkles className="h-4 w-4 shrink-0 text-muted" />}
      status={
        <div className="flex items-center gap-2">
          <StatusDot
            connected={connected}
            label={
              connected
                ? t("lifeopspanels.connected", { defaultValue: "Connected" })
                : t("lifeopspanels.disconnected", {
                    defaultValue: "Disconnected",
                  })
            }
          />
          <Button
            ref={refreshX.ref}
            size="sm"
            variant="outline"
            className="h-8 w-8 rounded-xl p-0"
            onClick={() => {
              void ownerX.refresh();
              void agentX.refresh();
            }}
            disabled={ownerX.loading || agentX.loading}
            title={refreshLabel}
            aria-label={refreshLabel}
            {...refreshX.agentProps}
          >
            {ownerX.loading || agentX.loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t("lifeopspanels.owner", { defaultValue: "Owner" })}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <StatusDot
              connected={connected}
              label={
                connected
                  ? t("lifeopspanels.connected", { defaultValue: "Connected" })
                  : t("lifeopspanels.disconnected", {
                      defaultValue: "Disconnected",
                    })
              }
            />
            {ownerIdentity ? (
              <div className="min-w-0 truncate text-sm font-semibold text-txt">
                {ownerIdentity}
              </div>
            ) : null}
          </div>
        </div>
        <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t("chat.agentType", { defaultValue: "Agent" })}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <StatusDot
              connected={agentConnected}
              label={
                agentConnected
                  ? t("lifeopspanels.connected", { defaultValue: "Connected" })
                  : t("lifeopspanels.disconnected", {
                      defaultValue: "Disconnected",
                    })
              }
            />
            {agentIdentity ? (
              <div className="min-w-0 truncate text-sm font-semibold text-txt">
                {agentIdentity}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          ref={openConnector.ref}
          size="sm"
          className="h-8 w-8 rounded-xl p-0"
          onClick={openXConnectorSettings}
          title={setupLabel}
          aria-label={setupLabel}
          {...openConnector.agentProps}
        >
          <Settings className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">
            {t("lifeopspanels.setup", { defaultValue: "Setup" })}
          </span>
        </Button>
      </div>

      {ownerX.error || agentX.error ? (
        <div className="text-xs text-danger">
          {ownerX.error ?? agentX.error}
        </div>
      ) : null}
    </PanelShell>
  );
}
