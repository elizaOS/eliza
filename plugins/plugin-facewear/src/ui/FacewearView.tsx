import { TerminalPluginView } from "@elizaos/ui";
import { Bluetooth, Glasses, Wifi, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { FacewearDeviceType } from "../devices/registry.ts";

interface ConnectedDevice {
  id: string;
  kind: "xr" | "smartglasses";
  deviceType?: string;
}

interface FacewearStatusResponse {
  connected: boolean;
  devices: ConnectedDevice[];
}

const DEVICE_PROFILES: Array<{
  type: FacewearDeviceType;
  name: string;
  manufacturer: string;
  connectionType: string;
  icon: typeof Glasses;
  description: string;
}> = [
  {
    type: "meta-quest",
    name: "Meta Quest 3 / 3S / Pro",
    manufacturer: "Meta",
    connectionType: "WebXR",
    icon: Glasses,
    description: "Full passthrough AR/VR with hand tracking and room scale.",
  },
  {
    type: "xreal",
    name: "XReal Air 3 / One Pro",
    manufacturer: "XREAL",
    connectionType: "WebXR",
    icon: Glasses,
    description: "3DoF AR glasses with spatial display and passthrough.",
  },
  {
    type: "even-realities",
    name: "Even Realities G1 / G2",
    manufacturer: "Even Realities",
    connectionType: "Bluetooth BLE",
    icon: Bluetooth,
    description: "OLED smartglasses with microphone and side-tap controls.",
  },
  {
    type: "apple-vision-pro",
    name: "Apple Vision Pro",
    manufacturer: "Apple",
    connectionType: "WebXR",
    icon: Glasses,
    description: "Spatial computing with eye and hand tracking on visionOS.",
  },
];

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
  profile: (typeof DEVICE_PROFILES)[number];
  connectedDevices: ConnectedDevice[];
  onConnect: (type: FacewearDeviceType) => void;
}) {
  const isConnected = connectedDevices.some(
    (d) =>
      d.deviceType === profile.type ||
      (profile.type === "even-realities" && d.kind === "smartglasses") ||
      (profile.connectionType === "WebXR" && d.kind === "xr"),
  );
  const Icon = profile.icon;

  return (
    <div
      className={`rounded-lg border p-4 transition-colors ${
        isConnected
          ? "border-green-500/30 bg-green-500/5"
          : "border-border/60 bg-card hover:border-border"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg ${
              isConnected ? "bg-green-500/15" : "bg-muted/20"
            }`}
          >
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
          className={`flex-shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${
            isConnected
              ? "bg-green-500/10 text-green-600 dark:text-green-400"
              : "bg-muted/20 text-muted"
          }`}
        >
          {isConnected ? "Connected" : "Disconnected"}
        </span>
      </div>
      <p className="mt-2 text-xs text-muted">{profile.description}</p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          <ConnectionIcon connectionType={profile.connectionType} />
          {profile.connectionType}
        </span>
        <button
          type="button"
          onClick={() => onConnect(profile.type)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-muted/20 transition-colors"
        >
          {isConnected ? "Manage" : "Connect"}
        </button>
      </div>
    </div>
  );
}

export function FacewearView() {
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
    const instructions: Record<FacewearDeviceType, string> = {
      "meta-quest":
        "Put on your Quest headset, open the browser, and navigate to the connect URL shown at /api/xr/connect",
      xreal:
        "Open the XReal browser on your glasses and navigate to the connect URL shown at /api/xr/connect",
      "even-realities":
        "Put on your Even Realities glasses — the agent will auto-detect them via Bluetooth BLE",
      "apple-vision-pro":
        "Open Safari on your Vision Pro and navigate to the connect URL shown at /api/xr/connect",
      simulator:
        "The WebXR simulator connects automatically when you open the emulator page",
    };
    alert(
      instructions[deviceType] ??
        "Follow the connection instructions for your device.",
    );
  }

  const activeCount = status.devices.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg text-txt">
      {/* Header */}
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Glasses className="h-4 w-4 text-accent" />
              <h1 className="text-sm font-semibold">Facewear</h1>
            </div>
            <p className="mt-1 text-xs text-muted">
              Manage all connected XR devices and smartglasses.
            </p>
          </div>
          <span
            className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium ${
              activeCount > 0
                ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300"
                : "border-border bg-muted/20 text-muted"
            }`}
          >
            <Zap className="h-3.5 w-3.5" />
            {activeCount > 0
              ? `${activeCount} device${activeCount === 1 ? "" : "s"} connected`
              : "No devices connected"}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="p-4">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {!loading && (
          <>
            {/* Connected devices summary */}
            {activeCount > 0 && (
              <div className="mb-4 rounded-lg border border-green-500/20 bg-green-500/5 p-3">
                <p className="text-xs font-medium text-green-600 dark:text-green-400">
                  Active connections
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {status.devices.map((device) => (
                    <span
                      key={device.id}
                      className="inline-flex items-center gap-1 rounded-md bg-green-500/10 px-2 py-0.5 text-xs text-green-700 dark:text-green-300"
                    >
                      {device.deviceType ?? device.kind}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Device cards */}
            <div className="grid gap-3 sm:grid-cols-2">
              {DEVICE_PROFILES.map((profile) => (
                <div key={profile.type}>
                  <DeviceCard
                    profile={profile}
                    connectedDevices={status.devices}
                    onConnect={handleConnect}
                  />
                </div>
              ))}
            </div>

            {/* Quick actions */}
            <div className="mt-4 rounded-lg border border-border/60 bg-card p-4">
              <h2 className="text-sm font-semibold">Quick Actions</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                <a
                  href="/api/xr/connect"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-muted/20 transition-colors"
                >
                  <Zap className="h-3.5 w-3.5" />
                  XR Connect Page
                </a>
                <a
                  href="/api/xr/status"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-muted/20 transition-colors"
                >
                  XR Status API
                </a>
                <button
                  type="button"
                  onClick={() => void fetchStatus()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-muted/20 transition-colors"
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
      label="Hearwear TUI"
      description="Terminal UI for hearwear device management"
      commands={[
        "connect-device",
        "manage-views",
        "device-diagnostics",
        "emulator",
      ]}
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
      description="Terminal UI for smartglasses setup, status, and diagnostics"
      commands={[
        "connect-headset",
        "run-hardware-check",
        "guided-side-tap-audio-validation",
        "configure-wifi",
      ]}
      endpoints={["/api/facewear/status", "/api/facewear/devices"]}
    />
  );
}

export { SmartglassesView } from "./SmartglassesView.tsx";
