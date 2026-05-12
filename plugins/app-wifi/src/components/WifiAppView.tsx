/**
 * WifiAppView — full-screen overlay for the WiFi app.
 *
 * Calls into `@elizaos/capacitor-wifi` to read the active connection, scan
 * for nearby networks, and (on press) attempt a connect. The component owns
 * all of its own data; there is no server-side route. Permissions
 * (`ACCESS_FINE_LOCATION` in particular) are expected to be granted
 * already; if scans return a permission rejection we surface the message
 * inline rather than retrying silently.
 */

import type {
  ConnectResult,
  WiFiNetwork,
  WifiStateResult,
} from "@elizaos/capacitor-wifi";
import { WiFi } from "@elizaos/capacitor-wifi";
import { Button, type OverlayAppContext } from "@elizaos/ui";
import {
  ChevronLeft,
  Lock,
  RefreshCw,
  Wifi as WifiIcon,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface SignalBarsProps {
  rssi: number;
}

/**
 * Map dBm to a 0–4 bar count. Standard Android thresholds:
 *   >= -50  → 4 bars (excellent)
 *   >= -60  → 3 bars
 *   >= -70  → 2 bars
 *   >= -80  → 1 bar
 *   else    → 0
 */
function signalBars(rssi: number): number {
  if (rssi >= -50) return 4;
  if (rssi >= -60) return 3;
  if (rssi >= -70) return 2;
  if (rssi >= -80) return 1;
  return 0;
}

function SignalBars({ rssi }: SignalBarsProps) {
  const bars = signalBars(rssi);
  return (
    <div
      role="img"
      aria-label={`Signal ${bars} of 4`}
      className="flex items-end gap-0.5"
    >
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className={`w-1 rounded-sm ${i < bars ? "bg-txt" : "bg-muted/30"}`}
          style={{ height: `${4 + i * 3}px` }}
        />
      ))}
    </div>
  );
}

interface ConnectedCardProps {
  state: WifiStateResult | null;
  network: WiFiNetwork | null;
  onDisconnect: () => void;
  busy: boolean;
}

function ConnectedCard({
  state,
  network,
  onDisconnect,
  busy,
}: ConnectedCardProps) {
  if (!state?.enabled) {
    return (
      <div className="rounded-2xl border border-border/30 bg-card/40 p-4">
        <div className="flex items-center gap-3">
          <WifiOff className="h-5 w-5 text-muted-strong" />
          <div className="text-sm text-muted">Wi-Fi is off</div>
        </div>
      </div>
    );
  }
  if (!network) {
    return (
      <div className="rounded-2xl border border-border/30 bg-card/40 p-4">
        <div className="flex items-center gap-3">
          <WifiIcon className="h-5 w-5 text-muted-strong" />
          <div className="text-sm text-muted">Not connected</div>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-border/30 bg-card/40 p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <WifiIcon className="h-5 w-5 text-txt" />
          <div>
            <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted/70">
              Connected
            </div>
            <div className="text-base font-semibold text-txt">
              {network.ssid || "(hidden)"}
            </div>
            <div className="font-mono text-xs text-muted">
              {network.rssi} dBm · {network.frequency} MHz
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <SignalBars rssi={network.rssi} />
          <Button
            variant="outline"
            size="sm"
            onClick={onDisconnect}
            disabled={busy}
          >
            Disconnect
          </Button>
        </div>
      </div>
    </div>
  );
}

interface NetworkRowProps {
  network: WiFiNetwork;
  onSelect: (network: WiFiNetwork) => void;
}

function NetworkRow({ network, onSelect }: NetworkRowProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(network)}
      className="flex w-full items-center justify-between gap-3 rounded-xl border border-border/24 bg-bg/60 px-4 py-3 text-left transition-colors hover:bg-bg-accent"
    >
      <div className="flex min-w-0 items-center gap-3">
        {network.secured ? (
          <Lock className="h-4 w-4 shrink-0 text-muted-strong" />
        ) : (
          <WifiIcon className="h-4 w-4 shrink-0 text-muted-strong" />
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-txt">
            {network.ssid || "(hidden)"}
          </div>
          <div className="truncate font-mono text-2xs text-muted">
            {network.bssid} · {network.rssi} dBm
          </div>
        </div>
      </div>
      <SignalBars rssi={network.rssi} />
    </button>
  );
}

export function WifiAppView(props: OverlayAppContext) {
  const { exitToApps } = props;

  const [state, setState] = useState<WifiStateResult | null>(null);
  const [connected, setConnected] = useState<WiFiNetwork | null>(null);
  const [networks, setNetworks] = useState<WiFiNetwork[]>([]);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<WiFiNetwork | null>(null);
  const [password, setPassword] = useState("");

  const refreshState = useCallback(async () => {
    const [stateResult, connectedResult] = await Promise.all([
      WiFi.getWifiState(),
      WiFi.getConnectedNetwork(),
    ]);
    setState(stateResult);
    setConnected(connectedResult.network);
  }, []);

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const result = await WiFi.listAvailableNetworks({ limit: 50 });
      setNetworks(result.networks);
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }, [refreshState]);

  useEffect(() => {
    void scan();
  }, [scan]);

  const handleSelect = useCallback((network: WiFiNetwork) => {
    setSelected(network);
    setPassword("");
  }, []);

  const handleConnect = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const result: ConnectResult = await WiFi.connectToNetwork({
        ssid: selected.ssid,
        password: selected.secured ? password : undefined,
      });
      if (!result.success) {
        setError(result.message ?? "Failed to connect");
      } else {
        setSelected(null);
        setPassword("");
        await refreshState();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [password, refreshState, selected]);

  const handleDisconnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await WiFi.disconnectFromNetwork();
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refreshState]);

  const sortedNetworks = useMemo(() => {
    return [...networks].sort((a, b) => b.rssi - a.rssi);
  }, [networks]);

  return (
    <div className="fixed inset-0 z-50 flex h-[100vh] w-full flex-col overflow-hidden bg-bg pb-[var(--safe-area-bottom,0px)] pl-[var(--safe-area-left,0px)] pr-[var(--safe-area-right,0px)] pt-[var(--safe-area-top,0px)] supports-[height:100dvh]:h-[100dvh]">
      <header className="flex items-center justify-between gap-3 border-b border-border/24 px-4 py-3">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={exitToApps}
            aria-label="Back to apps"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="text-base font-semibold text-txt">WiFi</div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void scan();
          }}
          disabled={scanning}
        >
          <RefreshCw
            className={`mr-1 h-4 w-4 ${scanning ? "animate-spin" : ""}`}
          />
          Scan
        </Button>
      </header>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        <ConnectedCard
          state={state}
          network={connected}
          onDisconnect={handleDisconnect}
          busy={busy}
        />

        {error ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted/70">
            Nearby networks
          </div>
          {sortedNetworks.length === 0 && !scanning ? (
            <div className="rounded-xl border border-border/24 bg-bg/40 px-4 py-6 text-center text-sm text-muted">
              No networks found.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {sortedNetworks.map((network) => (
                <NetworkRow
                  key={`${network.bssid}-${network.ssid}`}
                  network={network}
                  onSelect={handleSelect}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {selected ? (
        <div className="border-t border-border/24 bg-card/40 px-4 py-3">
          <div className="flex flex-col gap-3">
            <div className="text-sm text-txt">
              Connect to{" "}
              <span className="font-semibold">
                {selected.ssid || "(hidden)"}
              </span>
            </div>
            {selected.secured ? (
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className="w-full rounded-md border border-border/30 bg-bg px-3 py-2 text-sm text-txt outline-none focus:border-border/60"
              />
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSelected(null);
                  setPassword("");
                }}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={handleConnect} disabled={busy}>
                Connect
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
