/**
 * VincentConnectionCard — OAuth connect/disconnect UI for Vincent.
 *
 * Shows a green connected state with timestamp when authenticated, or
 * a "Connect Vincent" call-to-action when not. Uses useVincentState for
 * the full PKCE-based OAuth flow.
 */

import { Button, StatusDot } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { KeyRound, LogIn, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import { useVincentState } from "./useVincentState";

interface VincentConnectionCardProps {
  onConnectedChange?: (connected: boolean) => void;
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
  ) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function formatConnectedAt(ts: number | null): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function VincentConnectionCard({
  setActionNotice,
  t,
}: VincentConnectionCardProps) {
  const {
    vincentConnected,
    vincentLoginBusy,
    vincentLoginError,
    vincentConnectedAt,
    handleVincentLogin,
    handleVincentDisconnect,
  } = useVincentState({ setActionNotice, t });

  const disconnectLabel = t("vincent.disconnect", {
    defaultValue: "Disconnect",
  });
  const connectLabel = t("vincent.connect", {
    defaultValue: "Connect Vincent",
  });
  const disconnect = useAgentElement<HTMLButtonElement>({
    id: "action-disconnect",
    role: "button",
    label: disconnectLabel,
    group: "vincent-connection",
    description: "Disconnect the linked Vincent account",
  });
  const connect = useAgentElement<HTMLButtonElement>({
    id: "action-connect",
    role: "button",
    label: connectLabel,
    group: "vincent-connection",
    description: "Start the Vincent OAuth login to connect an account",
  });

  return (
    <div className="rounded-2xl border border-border/18 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_98%,transparent))] px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
      <div className="flex items-center justify-between gap-4">
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 sm:grid-cols-3">
          <div
            className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 ${
              vincentConnected
                ? "border-ok/25 bg-ok/10 text-ok"
                : "border-border/25 bg-card/50 text-muted"
            }`}
          >
            <StatusDot
              status={vincentConnected ? "connected" : "muted"}
              tone={vincentConnected ? "success" : "muted"}
              className="shrink-0"
            />
            <span className="truncate text-xs font-semibold">
              {vincentConnected
                ? t("vincent.connected", { defaultValue: "Connected" })
                : t("vincent.disconnected", { defaultValue: "Offline" })}
            </span>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-border/25 bg-card/50 px-3 py-2.5 text-muted">
            <KeyRound className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate text-xs font-semibold">OAuth</span>
          </div>
          <div className="hidden items-center gap-2 rounded-xl border border-border/25 bg-card/50 px-3 py-2.5 text-muted sm:flex">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate text-xs font-semibold">
              {vincentConnectedAt
                ? formatConnectedAt(vincentConnectedAt)
                : "Ready"}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {vincentConnected ? (
            <Button
              ref={disconnect.ref}
              {...disconnect.agentProps}
              variant="outline"
              size="sm"
              className="h-9 rounded-xl px-4 text-xs font-semibold text-status-danger border-status-danger/30 hover:bg-status-danger-bg hover:text-status-danger"
              onClick={() => void handleVincentDisconnect()}
              aria-label={disconnectLabel}
            >
              <LogOut className="h-3.5 w-3.5" />
              {disconnectLabel}
            </Button>
          ) : (
            <Button
              ref={connect.ref}
              {...connect.agentProps}
              variant="default"
              size="sm"
              className="h-9 rounded-xl px-4 text-xs font-semibold"
              onClick={() => void handleVincentLogin()}
              disabled={vincentLoginBusy}
              aria-label={connectLabel}
            >
              {vincentLoginBusy ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogIn className="h-3.5 w-3.5" />
              )}
              {vincentLoginBusy
                ? t("vincent.connecting", { defaultValue: "Connecting…" })
                : t("vincent.connect", { defaultValue: "Connect Vincent" })}
            </Button>
          )}
        </div>
      </div>

      {vincentLoginError && (
        <div className="mt-3 rounded-lg border border-status-danger/20 bg-status-danger-bg px-3 py-2 text-xs text-status-danger">
          {vincentLoginError}
        </div>
      )}
    </div>
  );
}
