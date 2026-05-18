import { Copy } from "lucide-react";
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
  accessUrl?: string | null;
  ssh?: {
    command: string;
    localUrl: string;
  } | null;
  reason?: string;
};

export function CloudInstancePanel() {
  const { copyToClipboard, setActionNotice, t, elizaCloudConnected } = useApp();
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
  const accessUrl =
    relayStatus?.available && relayStatus.accessUrl
      ? relayStatus.accessUrl
      : null;
  const sshTunnel =
    relayStatus?.available && relayStatus.ssh ? relayStatus.ssh : null;

  const copyAccessUrl = useCallback(async () => {
    if (!accessUrl) return;
    try {
      await copyToClipboard(accessUrl);
      setActionNotice(
        t("settings.instanceRoutingAccessUrlCopied", {
          defaultValue: "Home access URL copied.",
        }),
        "success",
        2200,
      );
    } catch {
      setActionNotice(
        t("settings.instanceRoutingAccessUrlCopyFailed", {
          defaultValue: "Could not copy home access URL.",
        }),
        "error",
        3200,
      );
    }
  }, [accessUrl, copyToClipboard, setActionNotice, t]);

  const copySshCommand = useCallback(async () => {
    if (!sshTunnel) return;
    try {
      await copyToClipboard(sshTunnel.command);
      setActionNotice(
        t("settings.instanceRoutingSshCommandCopied", {
          defaultValue: "SSH tunnel command copied.",
        }),
        "success",
        2200,
      );
    } catch {
      setActionNotice(
        t("settings.instanceRoutingSshCommandCopyFailed", {
          defaultValue: "Could not copy SSH tunnel command.",
        }),
        "error",
        3200,
      );
    }
  }, [copyToClipboard, setActionNotice, sshTunnel, t]);

  return (
    <PagePanel.Notice
      tone={isActive ? "accent" : elizaCloudConnected ? "default" : "warning"}
      className="mt-4"
      actions={
        <Button
          variant="outline"
          size="sm"
          className="h-8 rounded-sm px-4 text-xs-tight font-semibold"
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
            {accessUrl || sshTunnel ? (
              <HomeAccessDetails
                accessUrl={accessUrl}
                sshTunnel={sshTunnel}
                onCopyAccessUrl={copyAccessUrl}
                onCopySshCommand={copySshCommand}
              />
            ) : null}
          </div>
        ) : isRegistered ? (
          <div className="space-y-2">
            <div className="text-muted">
              {t("settings.instanceRoutingRegistered", {
                defaultValue:
                  "Instance registered with cloud but not actively polling. It will start receiving messages shortly.",
              })}
            </div>
            {accessUrl || sshTunnel ? (
              <HomeAccessDetails
                accessUrl={accessUrl}
                sshTunnel={sshTunnel}
                onCopyAccessUrl={copyAccessUrl}
                onCopySshCommand={copySshCommand}
              />
            ) : null}
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

function HomeAccessDetails({
  accessUrl,
  sshTunnel,
  onCopyAccessUrl,
  onCopySshCommand,
}: {
  accessUrl: string | null;
  sshTunnel: { command: string; localUrl: string } | null;
  onCopyAccessUrl: () => Promise<void>;
  onCopySshCommand: () => Promise<void>;
}) {
  return (
    <div className="space-y-2 rounded-sm border border-border/60 bg-bg/60 p-2">
      {accessUrl ? (
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="font-semibold text-txt">Home access URL</div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-sm px-2 text-[11px] font-semibold"
              onClick={() => {
                void onCopyAccessUrl();
              }}
            >
              <Copy className="mr-1 h-3 w-3" />
              Copy
            </Button>
          </div>
          <div className="break-all font-mono text-[11px] text-muted">
            {accessUrl}
          </div>
          <div className="mt-1 text-[11px] text-muted">
            Open this from another device to route back to this home instance
            through Eliza Cloud.
          </div>
        </div>
      ) : null}
      {sshTunnel ? (
        <div className="border-t border-border/50 pt-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="font-semibold text-txt">SSH tunnel</div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-sm px-2 text-[11px] font-semibold"
              onClick={() => {
                void onCopySshCommand();
              }}
            >
              <Copy className="mr-1 h-3 w-3" />
              Copy
            </Button>
          </div>
          <div className="break-all font-mono text-[11px] text-muted">
            {sshTunnel.command}
          </div>
          <div className="mt-1 text-[11px] text-muted">
            After the tunnel is running, use{" "}
            <span className="font-mono text-txt">{sshTunnel.localUrl}</span> as
            the home Satellite URL.
          </div>
        </div>
      ) : null}
    </div>
  );
}
