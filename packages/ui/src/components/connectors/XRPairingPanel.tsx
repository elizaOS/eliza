/**
 * Setup panel for pairing XR / smart-glasses devices: polls pair state via the
 * API client while the document is visible and renders the connected-device
 * count plus the pairing action.
 */

import { useCallback, useEffect, useState } from "react";
import { client, type XRPairState } from "../../api";
import { useIntervalWhenDocumentVisible } from "../../hooks/useDocumentVisibility";
import {
  type TranslationContextValue,
  useTranslation,
} from "../../state/TranslationContext.hooks";
import { openExternalUrl } from "../../utils";
import { Button } from "../ui/button";

type TranslateFn = TranslationContextValue["t"];

function DeviceBadge({ count, t }: { count: number; t: TranslateFn }) {
  if (count === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-muted/20 px-2.5 py-1 text-xs font-medium text-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-muted/60" />
        {t("xrpairing.noDevices", { defaultValue: "No devices connected" })}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
      {t("xrpairing.devicesConnected", {
        count,
        defaultValue: "{{count}} devices connected",
      })}
    </span>
  );
}

export function XRPairingPanel() {
  const { t } = useTranslation();
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

  // Fetch once on mount; poll only while the tab is visible so a backgrounded
  // connectors page doesn't hit the network every 5s (the interval is cleared on
  // hide and re-established on show).
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useIntervalWhenDocumentVisible(() => void refresh(), 5000);

  const openConnectPage = useCallback(() => {
    const base = client.baseUrl || "";
    void openExternalUrl(`${base}/api/xr/connect`);
  }, []);

  if (error) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          {t("xrpairing.retry", { defaultValue: "Retry" })}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <DeviceBadge count={state?.connections.length ?? 0} t={t} />
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
              {t("xrpairing.connectedAt", {
                time: new Date(c.connectedAt).toLocaleTimeString("en-US"),
                defaultValue: " — connected {{time}}",
              })}
            </li>
          ))}
        </ul>
      ) : (
        <ol className="list-inside list-decimal space-y-1 text-xs text-muted">
          <li>
            {t("xrpairing.step1", {
              defaultValue: "Put on your headset and open the browser",
            })}
          </li>
          <li>
            {t("xrpairing.step2LeadIn", {
              defaultValue: "Scan the QR code or type the pair code",
            })}{" "}
            {state?.pairingCode ? (
              <span className="font-mono font-semibold text-txt">
                {state.pairingCode}
              </span>
            ) : null}{" "}
            {t("xrpairing.step2Trailing", {
              defaultValue: "shown on the connect page",
            })}
          </li>
          <li>
            {t("xrpairing.step3", {
              defaultValue: "Allow microphone and camera access when prompted",
            })}
          </li>
        </ol>
      )}

      <Button
        variant="outline"
        size="sm"
        className="h-8 rounded-sm px-4 text-xs-tight font-semibold"
        onClick={openConnectPage}
      >
        {t("xrpairing.openConnectPage", { defaultValue: "Open connect page" })}
      </Button>
    </div>
  );
}
