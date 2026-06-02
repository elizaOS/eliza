import { Copy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../api";
import { useDocumentVisibility } from "../../hooks/useDocumentVisibility";
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

type RelayDetails = {
  isActive: boolean;
  isRegistered: boolean;
  accessUrl: string | null;
  sshTunnel: NonNullable<RelayStatus["ssh"]> | null;
};

type AppT = ReturnType<typeof useApp>["t"];

function useRelayStatus() {
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

  const documentVisible = useDocumentVisibility();
  useEffect(() => {
    // Poll relay status only while the document is visible so a backgrounded
    // window stops polling /api/cloud/relay-status.
    if (!documentVisible) return;
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 30_000);
    return () => clearInterval(interval);
  }, [refresh, documentVisible]);

  return { relayStatus, loading, refresh };
}

function getRelayDetails(relayStatus: RelayStatus | null): RelayDetails {
  return {
    isActive: Boolean(
      relayStatus?.available && relayStatus?.status === "polling",
    ),
    isRegistered: Boolean(
      relayStatus?.available && relayStatus?.status === "registered",
    ),
    accessUrl:
      relayStatus?.available && relayStatus.accessUrl
        ? relayStatus.accessUrl
        : null,
    sshTunnel:
      relayStatus?.available && relayStatus.ssh ? relayStatus.ssh : null,
  };
}

function useHomeAccessCopyActions(details: RelayDetails) {
  const { copyToClipboard, setActionNotice, t } = useApp();
  const copyAccessUrl = useCallback(async () => {
    if (!details.accessUrl) return;
    try {
      await copyToClipboard(details.accessUrl);
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
  }, [copyToClipboard, details.accessUrl, setActionNotice, t]);

  const copySshCommand = useCallback(async () => {
    if (!details.sshTunnel) return;
    try {
      await copyToClipboard(details.sshTunnel.command);
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
  }, [copyToClipboard, details.sshTunnel, setActionNotice, t]);

  return { copyAccessUrl, copySshCommand };
}

export function CloudInstancePanel() {
  const { t, elizaCloudConnected } = useApp();
  const { relayStatus, loading, refresh } = useRelayStatus();
  const relayDetails = getRelayDetails(relayStatus);
  const { copyAccessUrl, copySshCommand } =
    useHomeAccessCopyActions(relayDetails);

  return (
    <PagePanel.Notice
      tone={
        relayDetails.isActive
          ? "accent"
          : elizaCloudConnected
            ? "default"
            : "warning"
      }
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

        <CloudInstanceStatus
          connected={elizaCloudConnected}
          relayStatus={relayStatus}
          relayDetails={relayDetails}
          onCopyAccessUrl={copyAccessUrl}
          onCopySshCommand={copySshCommand}
          t={t}
        />
      </div>
    </PagePanel.Notice>
  );
}

function CloudInstanceStatus({
  connected,
  relayStatus,
  relayDetails,
  onCopyAccessUrl,
  onCopySshCommand,
  t,
}: {
  connected: boolean;
  relayStatus: RelayStatus | null;
  relayDetails: RelayDetails;
  onCopyAccessUrl: () => Promise<void>;
  onCopySshCommand: () => Promise<void>;
  t: AppT;
}) {
  if (!connected) return <CloudInstanceDisconnected t={t} />;
  if (relayDetails.isActive) {
    return (
      <CloudInstanceActive
        relayStatus={relayStatus}
        relayDetails={relayDetails}
        onCopyAccessUrl={onCopyAccessUrl}
        onCopySshCommand={onCopySshCommand}
        t={t}
      />
    );
  }
  if (relayDetails.isRegistered) {
    return (
      <CloudInstanceRegistered
        relayDetails={relayDetails}
        onCopyAccessUrl={onCopyAccessUrl}
        onCopySshCommand={onCopySshCommand}
        t={t}
      />
    );
  }
  return <CloudInstanceInactive relayStatus={relayStatus} t={t} />;
}

function CloudInstanceDisconnected({ t }: { t: AppT }) {
  return (
    <div className="text-muted">
      {t("settings.instanceRoutingNotConnected", {
        defaultValue:
          "Connect to Eliza Cloud above to enable instance routing. This lets messages from any platform reach your local instance through the cloud gateway.",
      })}
    </div>
  );
}

function CloudInstanceActive({
  relayStatus,
  relayDetails,
  onCopyAccessUrl,
  onCopySshCommand,
  t,
}: {
  relayStatus: RelayStatus | null;
  relayDetails: RelayDetails;
  onCopyAccessUrl: () => Promise<void>;
  onCopySshCommand: () => Promise<void>;
  t: AppT;
}) {
  return (
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
      <HomeAccessDetailsIfPresent
        relayDetails={relayDetails}
        onCopyAccessUrl={onCopyAccessUrl}
        onCopySshCommand={onCopySshCommand}
      />
    </div>
  );
}

function CloudInstanceRegistered({
  relayDetails,
  onCopyAccessUrl,
  onCopySshCommand,
  t,
}: {
  relayDetails: RelayDetails;
  onCopyAccessUrl: () => Promise<void>;
  onCopySshCommand: () => Promise<void>;
  t: AppT;
}) {
  return (
    <div className="space-y-2">
      <div className="text-muted">
        {t("settings.instanceRoutingRegistered", {
          defaultValue:
            "Instance registered with cloud but not actively polling. It will start receiving messages shortly.",
        })}
      </div>
      <HomeAccessDetailsIfPresent
        relayDetails={relayDetails}
        onCopyAccessUrl={onCopyAccessUrl}
        onCopySshCommand={onCopySshCommand}
      />
    </div>
  );
}

function CloudInstanceInactive({
  relayStatus,
  t,
}: {
  relayStatus: RelayStatus | null;
  t: AppT;
}) {
  return (
    <div className="text-muted">
      {relayStatus?.reason ??
        t("settings.instanceRoutingInactive", {
          defaultValue:
            "Cloud connected but gateway relay not active. The relay starts automatically when the elizacloud plugin loads.",
        })}
    </div>
  );
}

function HomeAccessDetailsIfPresent({
  relayDetails,
  onCopyAccessUrl,
  onCopySshCommand,
}: {
  relayDetails: RelayDetails;
  onCopyAccessUrl: () => Promise<void>;
  onCopySshCommand: () => Promise<void>;
}) {
  if (!relayDetails.accessUrl && !relayDetails.sshTunnel) return null;
  return (
    <HomeAccessDetails
      accessUrl={relayDetails.accessUrl}
      sshTunnel={relayDetails.sshTunnel}
      onCopyAccessUrl={onCopyAccessUrl}
      onCopySshCommand={onCopySshCommand}
    />
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
            the home Remote URL.
          </div>
        </div>
      ) : null}
    </div>
  );
}
