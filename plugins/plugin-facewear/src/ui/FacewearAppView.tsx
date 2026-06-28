import { TerminalPluginView } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Bluetooth, Glasses, Wifi, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  type ConnectedDevice,
  FACEWEAR_DEVICE_PROFILES,
  type FacewearDeviceProfileRow,
  type FacewearStatusResponse,
  isProfileConnected,
} from "../components/facewear-profiles.ts";
import type { FacewearDeviceType } from "../devices/registry.ts";

const ACTIVE_DEVICE_LIMIT = 4;

function ConnectionIcon({ connectionType }: { connectionType: string }) {
  if (connectionType.toLowerCase().includes("bluetooth")) {
    return <Bluetooth className="h-4 w-4" />;
  }
  if (connectionType.toLowerCase().includes("wifi")) {
    return <Wifi className="h-4 w-4" />;
  }
  return <Zap className="h-4 w-4" />;
}

function DeviceCard({
  profile,
  connectedDevices,
  onConnect,
}: {
  profile: FacewearDeviceProfileRow;
  connectedDevices: ConnectedDevice[];
  onConnect: (type: FacewearDeviceType) => void;
}) {
  const isConnected = isProfileConnected(profile, connectedDevices);
  const Icon = profile.connectionType.toLowerCase().includes("bluetooth")
    ? Bluetooth
    : Glasses;
  const actionLabel = isConnected
    ? `Manage ${profile.name}`
    : `Connect ${profile.name}`;
  const { ref: connectRef, agentProps: connectAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `device-${profile.type}`,
      role: "button",
      label: actionLabel,
      group: "devices",
      status: isConnected ? "active" : "inactive",
      description: `${isConnected ? "Manage" : "Connect"} the ${profile.name} device`,
    });

  return (
    <div className="py-3 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center">
            <Icon
              className={`h-5 w-5 ${isConnected ? "text-green-500" : "text-muted"}`}
            />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-txt">
              {profile.name}
            </p>
            <p className="text-xs text-muted">{profile.manufacturer}</p>
          </div>
        </div>
        <span
          className={`flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium ${
            isConnected ? "text-green-600 dark:text-green-400" : "text-muted"
          }`}
        >
          {isConnected ? "On" : "Off"}
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          <ConnectionIcon connectionType={profile.connectionType} />
          {profile.connectionType}
        </span>
        <button
          ref={connectRef}
          type="button"
          onClick={() => onConnect(profile.type)}
          aria-label={actionLabel}
          className="inline-flex h-8 items-center gap-1.5 px-3 text-xs font-medium hover:bg-muted/20 transition-colors"
          {...connectAgentProps}
        >
          {isConnected ? "Manage" : "Connect"}
        </button>
      </div>
    </div>
  );
}

export function FacewearAppView({
  onOpenSmartglasses,
  embedded,
}: {
  onOpenSmartglasses?: () => void;
  /** When rendered inside the Settings subview, suppress the duplicate header. */
  embedded?: boolean;
} = {}) {
  const [status, setStatus] = useState<FacewearStatusResponse>({
    connected: false,
    devices: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/facewear/status");
      if (res.ok) {
        const data = (await res.json()) as FacewearStatusResponse;
        setStatus(data);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    const interval = setInterval(() => void fetchStatus(), 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  function handleConnect(deviceType: FacewearDeviceType): void {
    if (deviceType === "even-realities") {
      if (onOpenSmartglasses) {
        onOpenSmartglasses();
        return;
      }
      window.location.assign("/apps/smartglasses");
      return;
    }
    window.open("/api/xr/connect", "_blank", "noopener,noreferrer");
  }

  const activeCount = status.devices.length;

  const { ref: xrConnectRef, agentProps: xrConnectAgentProps } =
    useAgentElement<HTMLAnchorElement>({
      id: "link-xr-connect",
      role: "link",
      label: "Connect",
      group: "quick-actions",
      description: "Open the XR device connect page in a new tab",
    });
  const { ref: xrStatusRef, agentProps: xrStatusAgentProps } =
    useAgentElement<HTMLAnchorElement>({
      id: "link-xr-status",
      role: "link",
      label: "Status",
      group: "quick-actions",
      description: "Open the XR status API in a new tab",
    });
  const { ref: refreshRef, agentProps: refreshAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "action-refresh",
      role: "button",
      label: "Refresh",
      group: "quick-actions",
      description: "Refresh the connected device status",
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg text-txt">
      {embedded ? null : (
        <div className="px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Glasses className="h-4 w-4 text-accent" />
                <h1 className="text-sm font-semibold">Facewear</h1>
              </div>
            </div>
            <span
              className={`inline-flex h-7 items-center gap-1.5 px-1.5 text-xs font-medium ${
                activeCount > 0
                  ? "text-green-700 dark:text-green-300"
                  : "text-muted"
              }`}
            >
              <Zap className="h-3.5 w-3.5" />
              {activeCount > 0 ? `${activeCount} on` : "0 on"}
            </span>
          </div>
        </div>
      )}

      <div className="mx-auto w-full max-w-3xl p-4">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
          </div>
        )}

        {error && (
          <div className="mb-4 px-1 py-2 text-xs text-destructive">{error}</div>
        )}

        {!loading && (
          <>
            {activeCount > 0 && (
              <div className="mb-3">
                <div className="flex flex-wrap gap-2">
                  {status.devices
                    .slice(0, ACTIVE_DEVICE_LIMIT)
                    .map((device) => (
                      <span
                        key={device.id}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs text-green-700 dark:text-green-300"
                      >
                        {device.deviceType ?? device.kind}
                      </span>
                    ))}
                  {status.devices.length > ACTIVE_DEVICE_LIMIT ? (
                    <span className="inline-flex items-center px-1.5 py-0.5 text-xs text-muted">
                      +{status.devices.length - ACTIVE_DEVICE_LIMIT}
                    </span>
                  ) : null}
                </div>
              </div>
            )}

            <div className="grid gap-3">
              {FACEWEAR_DEVICE_PROFILES.map((profile) => (
                <DeviceCard
                  key={profile.type}
                  profile={profile}
                  connectedDevices={status.devices}
                  onConnect={handleConnect}
                />
              ))}
            </div>

            <div className="mt-4">
              <div className="flex flex-wrap gap-2">
                <a
                  ref={xrConnectRef}
                  href="/api/xr/connect"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="XR connect"
                  className="inline-flex h-8 items-center gap-1.5 px-3 text-xs font-medium hover:bg-muted/20 transition-colors"
                  {...xrConnectAgentProps}
                >
                  <Zap className="h-3.5 w-3.5" />
                  Connect
                </a>
                <a
                  ref={xrStatusRef}
                  href="/api/xr/status"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="XR status"
                  className="inline-flex h-8 items-center gap-1.5 px-3 text-xs font-medium hover:bg-muted/20 transition-colors"
                  {...xrStatusAgentProps}
                >
                  Status
                </a>
                <button
                  ref={refreshRef}
                  type="button"
                  onClick={() => void fetchStatus()}
                  aria-label="Refresh"
                  className="inline-flex h-8 items-center gap-1.5 px-3 text-xs font-medium hover:bg-muted/20 transition-colors"
                  {...refreshAgentProps}
                >
                  Refresh
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function FacewearTuiView() {
  return (
    <TerminalPluginView
      id="facewear"
      label="Facewear TUI"
      description="Status"
      commands={[]}
      endpoints={[
        "/api/facewear/status",
        "/api/facewear/devices",
        "/api/facewear/views",
      ]}
    />
  );
}

export function SmartglassesTuiView() {
  return (
    <TerminalPluginView
      id="smartglasses"
      label="Smartglasses TUI"
      description="Status"
      commands={[]}
      endpoints={["/api/facewear/status", "/api/facewear/devices"]}
    />
  );
}
