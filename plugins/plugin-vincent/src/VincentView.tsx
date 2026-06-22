/**
 * VincentView — the single GUI/XR data wrapper for the Vincent surface.
 *
 * It owns the live Vincent data (OAuth status, agent wallet addresses, strategy
 * and trading-profile polling, plus the connect/disconnect OAuth flow) and
 * renders the one presentational {@link VincentSpatialView} inside a
 * {@link SpatialSurface}. Omitting the `modality` prop lets `SpatialSurface`
 * auto-detect GUI vs XR via `window.__elizaXRContext`, so the SAME component
 * serves both surfaces. The TUI surface renders the same `VincentSpatialView`
 * through the terminal registry (see `register-terminal-view.tsx`).
 */

import { openExternalUrl, useAppSelector } from "@elizaos/ui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import { useCallback } from "react";
import {
  type VincentSnapshot,
  VincentSpatialView,
} from "./components/VincentSpatialView.tsx";
import { useVincentDashboard } from "./useVincentDashboard.ts";
import { useVincentState } from "./useVincentState.ts";

const VINCENT_DASHBOARD_URL = "https://heyvincent.ai";

/** Minimal i18n passthrough — the standalone view has no OverlayAppContext. */
function defaultTranslate(
  _key: string,
  opts?: Record<string, unknown>,
): string {
  return typeof opts?.defaultValue === "string" ? opts.defaultValue : _key;
}

export function VincentView() {
  const setActionNotice = useAppSelector((s) => s.setActionNotice);

  const {
    vincentConnected,
    vincentConnectedAt,
    walletAddresses,
    walletBalances,
    strategy,
    tradingProfile,
    loading,
    error,
    refresh,
  } = useVincentDashboard();

  const { handleVincentLogin, handleVincentDisconnect } = useVincentState({
    setActionNotice,
    t: defaultTranslate,
  });

  const copyAddress = useCallback(
    (address: string | null | undefined, label: string) => {
      if (!address) return;
      void navigator.clipboard.writeText(address).then(() => {
        setActionNotice(`${label} address copied`, "success", 2000);
      });
    },
    [setActionNotice],
  );

  const onAction = useCallback(
    (action: string) => {
      switch (action) {
        case "connect":
          void handleVincentLogin();
          return;
        case "disconnect":
          void handleVincentDisconnect();
          return;
        case "refresh":
          refresh();
          return;
        case "open-vincent":
          void openExternalUrl(VINCENT_DASHBOARD_URL);
          return;
        case "copy-evm":
          copyAddress(walletAddresses?.evmAddress, "EVM");
          return;
        case "copy-solana":
          copyAddress(walletAddresses?.solanaAddress, "Solana");
          return;
      }
    },
    [
      copyAddress,
      handleVincentDisconnect,
      handleVincentLogin,
      refresh,
      walletAddresses,
    ],
  );

  const snapshot: VincentSnapshot = {
    vincentConnected,
    vincentConnectedAt,
    walletAddresses,
    walletBalances,
    strategy,
    tradingProfile,
    loading,
    error,
  };

  return (
    <SpatialSurface>
      <VincentSpatialView snapshot={snapshot} onAction={onAction} />
    </SpatialSurface>
  );
}
