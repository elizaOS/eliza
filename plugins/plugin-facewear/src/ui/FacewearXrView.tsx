import { Bluetooth, Glasses, Wifi, Zap } from "lucide-react";
import { useEffect, useState } from "react";

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

  async function fetchStatus(): Promise<void> {
    try {
      const res = await fetch("/api/facewear/status");
      if (res.ok) {
        const data = (await res.json()) as FacewearStatusResponse;
        setStatus(data);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchStatus();
    const interval = setInterval(() => void fetchStatus(), 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      style={{
        background: "#0a0a0c",
        color: "#f4f4f5",
        minHeight: "100vh",
        padding: "32px",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: "20px",
        lineHeight: "1.6",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "16px",
          marginBottom: "32px",
          paddingBottom: "24px",
          borderBottom: "1px solid rgba(255,255,255,0.1)",
        }}
      >
        <Glasses style={{ width: "32px", height: "32px", color: "#6366f1" }} />
        <div>
          <h1 style={{ fontSize: "24px", fontWeight: 700, margin: 0 }}>
            Facewear
          </h1>
          <p style={{ fontSize: "16px", color: "#a1a1aa", margin: "4px 0 0" }}>
            elizaOS Device Hub
          </p>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              padding: "6px 14px",
              borderRadius: "20px",
              fontSize: "14px",
              fontWeight: 600,
              background: status.connected
                ? "rgba(34, 197, 94, 0.15)"
                : "rgba(255,255,255,0.08)",
              color: status.connected ? "#86efac" : "#a1a1aa",
              border: `1px solid ${status.connected ? "rgba(34,197,94,0.3)" : "rgba(255,255,255,0.1)"}`,
            }}
          >
            <Zap style={{ width: "14px", height: "14px" }} />
            {status.connected ? "Active" : "Standby"}
          </span>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "48px",
            color: "#a1a1aa",
          }}
        >
          Loading...
        </div>
      )}

      {/* Connected devices */}
      {!loading && status.devices.length > 0 && (
        <div style={{ marginBottom: "32px" }}>
          <h2
            style={{
              fontSize: "18px",
              fontWeight: 600,
              color: "#a1a1aa",
              marginBottom: "16px",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Connected Devices
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {status.devices.map((device) => (
              <div
                key={device.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "16px",
                  padding: "16px 20px",
                  borderRadius: "12px",
                  background: "rgba(99,102,241,0.1)",
                  border: "1px solid rgba(99,102,241,0.2)",
                }}
              >
                <DeviceIcon kind={device.kind} />
                <div>
                  <p style={{ fontWeight: 600, margin: 0 }}>
                    {device.deviceType ?? device.kind}
                  </p>
                  <p
                    style={{
                      fontSize: "14px",
                      color: "#86efac",
                      margin: "2px 0 0",
                    }}
                  >
                    Connected
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No devices */}
      {!loading && status.devices.length === 0 && (
        <div
          style={{
            padding: "48px 32px",
            borderRadius: "16px",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            textAlign: "center",
            color: "#a1a1aa",
          }}
        >
          <Wifi
            style={{
              width: "40px",
              height: "40px",
              margin: "0 auto 16px",
              opacity: 0.5,
            }}
          />
          <p style={{ fontSize: "18px", margin: 0 }}>No devices connected</p>
          <p style={{ fontSize: "14px", margin: "8px 0 0", opacity: 0.7 }}>
            Open the facewear app or connect via Bluetooth
          </p>
        </div>
      )}
    </div>
  );
}
