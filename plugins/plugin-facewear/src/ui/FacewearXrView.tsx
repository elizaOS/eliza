import { Bluetooth, Glasses, Wifi, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface ConnectedDevice {
  id: string;
  kind: "xr" | "smartglasses";
  deviceType?: string;
}

interface FacewearStatusResponse {
  connected: boolean;
  devices: ConnectedDevice[];
}

function DeviceIcon({ kind }: { kind: "xr" | "smartglasses" }) {
  if (kind === "smartglasses") return <Bluetooth className="h-6 w-6" />;
  return <Glasses className="h-6 w-6" />;
}

export function FacewearXrView() {
  const [status, setStatus] = useState<FacewearStatusResponse>({
    connected: false,
    devices: [],
  });
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/facewear/status");
      if (res.ok) {
        const data = (await res.json()) as FacewearStatusResponse;
        setStatus(data);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    const interval = setInterval(() => void fetchStatus(), 3000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  return (
    <div className="min-h-screen bg-bg p-8 text-txt">
      {/* Header */}
      <div className="mb-8 flex items-center gap-4 border-b border-border/60 pb-6">
        <Glasses className="h-8 w-8 text-accent" />
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="m-0 text-2xl font-bold">Facewear</h1>
          <span className="rounded-md border border-border bg-bg-accent/40 px-2 py-0.5 text-xs font-medium uppercase tracking-[0.08em] text-muted">
            XR hub
          </span>
        </div>
        <div className="ml-auto">
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-semibold ${
              status.connected
                ? "border-ok/30 bg-ok/10 text-ok"
                : "border-border bg-muted/10 text-muted"
            }`}
          >
            <Zap className="h-3.5 w-3.5" />
            {status.connected ? "Active" : "Standby"}
          </span>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center p-12 text-muted">
          Loading...
        </div>
      )}

      {/* Connected devices */}
      {!loading && status.devices.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-[0.08em] text-muted">
            Connected Devices
          </h2>
          <div className="flex flex-col gap-3">
            {status.devices.map((device) => (
              <div
                key={device.id}
                className="flex items-center gap-4 rounded-lg border border-accent/20 bg-accent-subtle/40 px-5 py-4"
              >
                <DeviceIcon kind={device.kind} />
                <div>
                  <div className="font-semibold">
                    {device.deviceType ?? device.kind}
                  </div>
                  <div className="mt-0.5 text-sm text-ok">Connected</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No devices */}
      {!loading && status.devices.length === 0 && (
        <div className="rounded-xl border border-border bg-bg-accent/30 px-8 py-12 text-center text-muted">
          <Wifi className="mx-auto mb-4 h-10 w-10 opacity-50" />
          <div className="text-lg font-medium text-txt">
            No devices connected
          </div>
          <div className="mt-2 text-sm text-muted/70">
            Open Facewear or pair via Bluetooth
          </div>
        </div>
      )}
    </div>
  );
}
