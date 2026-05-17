/**
 * VincentConnectionCard — OAuth connect/disconnect UI for Vincent.
 *
 * Shows a green connected state with timestamp when authenticated, or
 * a "Connect Vincent" call-to-action when not. Uses useVincentState for
 * the full PKCE-based OAuth flow.
 */

import { Button, StatusDot } from "@elizaos/ui";
import { LogIn, LogOut, RefreshCw } from "lucide-react";
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

  return (
    <div className="rounded-3xl border border-border/18 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_98%,transparent))] px-5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
      <div className="flex items-start justify-between gap-4">
        {/* Status */}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <StatusDot
            status={vincentConnected ? "connected" : "muted"}
            tone={vincentConnected ? "success" : "muted"}
            className="shrink-0"
          />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-txt">
              {vincentConnected
                ? t("vincent.connected", {
                    defaultValue: "Connected to Vincent",
                  })
                : t("vincent.disconnected", {
                    defaultValue: "Not connected to Vincent",
                  })}
            </div>
            {vincentConnected && vincentConnectedAt && (
              <div className="mt-0.5 text-xs text-muted">
                {t("vincent.connectedSince", {
                  defaultValue: "Connected since",
                })}{" "}
                {formatConnectedAt(vincentConnectedAt)}
              </div>
            )}
            {!vincentConnected && (
              <div className="mt-0.5 text-xs text-muted">
                {t("vincent.connectDescription", {
                  defaultValue:
                    "Connect Vincent to let its agent handle Hyperliquid and Polymarket execution.",
                })}
              </div>
            )}
          </div>
        </div>

        {/* Action */}
        <div className="flex shrink-0 items-center gap-2">
          {vincentConnected ? (
            <Button
              variant="outline"
              size="sm"
              className="h-9 rounded-xl px-4 text-xs font-semibold text-status-danger border-status-danger/30 hover:bg-status-danger-bg hover:text-status-danger"
              onClick={() => void handleVincentDisconnect()}
            >
              <LogOut className="h-3.5 w-3.5" />
              {t("vincent.disconnect", { defaultValue: "Disconnect" })}
            </Button>
          ) : (
            <Button
              variant="default"
              size="sm"
              className="h-9 rounded-xl px-4 text-xs font-semibold"
              onClick={() => void handleVincentLogin()}
              disabled={vincentLoginBusy}
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
