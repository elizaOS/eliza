import { useCallback, useEffect, useState } from "react";
import { client } from "../../api";
import { useApp } from "../../state";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";

type RelayStatus = {
  available: boolean;
  status: string;
  sessionId?: string | null;
  organizationId?: string | null;
  agentName?: string | null;
  lastSeenAt?: string | null;
  reason?: string;
};

export function CloudInstancePanel() {
  const { t, elizaCloudConnected } = useApp();
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = (await client.fetch(
        "/api/cloud/relay-status",
      )) as RelayStatus;
      setRelayStatus(res);
    } catch {
      setRelayStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const isActive = relayStatus?.available && relayStatus?.status === "polling";
  const isRegistered =
    relayStatus?.available && relayStatus?.status === "registered";

  return (
    <PagePanel.Notice
      tone={isActive ? "accent" : elizaCloudConnected ? "default" : "warning"}
      className="mt-4"
      actions={
        <Button
          variant="outline"
          size="sm"
          className="h-8 rounded-xl px-4 text-xs-tight font-semibold"
          onClick={() => {
            void refresh();
          }}
          disabled={loading}
        >
          {loading
            ? t("common.loading", { defaultValue: "Loading\u2026" })
            : t("common.refresh", { defaultValue: "Refresh" })}
        </Button>
      }
    >
      <div className="space-y-2 text-xs">
        <div className="font-semibold text-txt">
          {t("settings.instanceRouting", {
            defaultValue: "Instance Routing",
          })}
        </div>

        {!elizaCloudConnected ? (
          <div className="text-muted">
            {t("settings.instanceRoutingNotConnected", {
              defaultValue:
                "Connect to Eliza Cloud above to enable instance routing. This lets messages from any platform reach your local instance through the cloud gateway.",
            })}
          </div>
        ) : isActive ? (
          <div className="space-y-1">
            <div className="text-accent">
              {t("settings.instanceRoutingActive", {
                defaultValue:
                  "This instance is registered and receiving messages via Eliza Cloud gateway relay.",
              })}
            </div>
            {relayStatus?.agentName && (
              <div className="text-muted">
                Agent: <span className="text-txt">{relayStatus.agentName}</span>
              </div>
            )}
            {relayStatus?.lastSeenAt && (
              <div className="text-muted">
                Last heartbeat:{" "}
                <span className="text-txt">
                  {new Date(relayStatus.lastSeenAt).toLocaleTimeString()}
                </span>
              </div>
            )}
          </div>
        ) : isRegistered ? (
          <div className="text-muted">
            {t("settings.instanceRoutingRegistered", {
              defaultValue:
                "Instance registered with cloud but not actively polling. It will start receiving messages shortly.",
            })}
          </div>
        ) : (
          <div className="text-muted">
            {relayStatus?.reason ??
              t("settings.instanceRoutingInactive", {
                defaultValue:
                  "Cloud connected but gateway relay not active. The relay starts automatically when the elizacloud plugin loads.",
              })}
          </div>
        )}
      </div>
    </PagePanel.Notice>
  );
}
