import { Bluetooth, Glasses, Wifi, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const XR_DEVICE_LIMIT = 6;

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
    <div className="min-h-screen bg-bg p-6 text-txt">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center gap-4 border-b border-border/60 pb-4">
          <Glasses className="h-7 w-7 text-accent" />
          <h1 className="m-0 min-w-0 flex-1 text-xl font-bold">Facewear</h1>
          <span
            className={`inline-flex items-center gap-2 rounded-md border px-3 py-1 text-sm font-semibold ${
              status.connected
                ? "border-ok/30 bg-ok/10 text-ok"
                : "border-border bg-muted/10 text-muted"
            }`}
          >
            <Zap className="h-3.5 w-3.5" />
            {status.connected ? "Active" : "Standby"}
          </span>
        </div>

        {loading && (
          <div className="flex items-center justify-center p-12 text-muted">
            Loading...
          </div>
        )}

        {!loading && status.devices.length > 0 && (
          <div className="mb-8 flex flex-col gap-3">
            {status.devices.slice(0, XR_DEVICE_LIMIT).map((device) => (
              <div
                key={device.id}
                className="flex items-center gap-4 rounded-lg border border-accent/20 bg-accent-subtle/40 px-5 py-4"
              >
                <DeviceIcon kind={device.kind} />
                <div className="min-w-0">
                  <div className="truncate font-semibold">
                    {device.deviceType ?? device.kind}
                  </div>
                  <div className="mt-0.5 text-sm text-ok">Connected</div>
                </div>
              </div>
            ))}
            {status.devices.length > XR_DEVICE_LIMIT ? (
              <div className="rounded-lg border border-border/60 bg-muted/10 px-5 py-3 text-sm text-muted">
                +{status.devices.length - XR_DEVICE_LIMIT} more connected
              </div>
            ) : null}
          </div>
        )}

        {!loading && status.devices.length === 0 && (
          <div className="rounded-lg border border-border bg-bg-accent/30 px-8 py-12 text-center text-muted">
            <Wifi className="mx-auto mb-4 h-10 w-10 opacity-50" />
            <div className="text-lg font-medium text-txt">No devices</div>
            <div className="mt-2 text-sm text-muted/70">
              Open Facewear to connect.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
