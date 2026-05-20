import { useCallback, useEffect, useState } from "react";
import { client, type XRPairState } from "../../api";
import { openExternalUrl } from "../../utils";
import { Button } from "../ui/button";

function DeviceBadge({ count }: { count: number }) {
  if (count === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-muted/20 px-2.5 py-1 text-xs font-medium text-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-muted/60" />
        No devices connected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
      {count === 1 ? "1 device connected" : `${count} devices connected`}
    </span>
  );
}

export function XRPairingPanel() {
  const [state, setState] = useState<XRPairState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await client.getXRPairState();
      setState(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const openConnectPage = useCallback(() => {
    const base = client.baseUrl || "";
    void openExternalUrl(`${base}/api/xr/connect`);
  }, []);

  if (error) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <DeviceBadge count={state?.connections.length ?? 0} />
        {state?.pairingCode ? (
          <span className="font-mono text-sm font-bold tracking-widest text-accent">
            {state.pairingCode}
          </span>
        ) : null}
      </div>

      {(state?.connections.length ?? 0) > 0 ? (
        <ul className="space-y-1">
          {state?.connections.map((c) => (
            <li key={c.id} className="text-xs text-muted">
              <span className="font-medium text-txt">{c.deviceType}</span>
              {" — connected "}
              {new Date(c.connectedAt).toLocaleTimeString()}
            </li>
          ))}
        </ul>
      ) : (
        <ol className="list-inside list-decimal space-y-1 text-xs text-muted">
          <li>Put on your headset and open the browser</li>
          <li>
            Scan the QR code or type the pair code{" "}
            {state?.pairingCode ? (
              <span className="font-mono font-semibold text-txt">
                {state.pairingCode}
              </span>
            ) : null}{" "}
            shown on the connect page
          </li>
          <li>Allow microphone and camera access when prompted</li>
        </ol>
      )}

      <Button
        variant="outline"
        size="sm"
        className="h-8 rounded-sm px-4 text-xs-tight font-semibold"
        onClick={openConnectPage}
      >
        Open connect page
      </Button>
    </div>
  );
}
