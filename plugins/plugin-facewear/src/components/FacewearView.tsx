/**
 * FacewearView — the single GUI/XR data wrapper for the Facewear surface.
 *
 * It owns the live device data (status fetch + 5s poll, connect routing, XR
 * connect/status links, refresh) and renders the one presentational
 * {@link FacewearSpatialView} inside a {@link SpatialSurface}. Omitting the
 * `modality` prop lets `SpatialSurface` auto-detect GUI vs XR via
 * `window.__elizaXRContext`, so the SAME component serves both surfaces. The TUI
 * surface renders the same `FacewearSpatialView` through the terminal registry
 * (see `register-terminal-view.tsx`).
 *
 * The full-screen GUI dashboard (`../ui/FacewearAppView.tsx`) is unchanged; it
 * stays mounted as the app-shell page while this wrapper drives the
 * manager/XR/TUI surfaces from the same status DTO.
 */

import { SpatialSurface } from "@elizaos/ui/spatial";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FacewearDeviceType } from "../devices/registry.ts";
import {
  type FacewearSnapshot,
  FacewearSpatialView,
} from "./FacewearSpatialView.tsx";
import {
  type ConnectedDevice,
  FACEWEAR_DEVICE_PROFILES,
  type FacewearStatusResponse,
  isProfileConnected,
} from "./facewear-profiles.ts";

/** Route a connect/manage request the same way the legacy dashboard does. */
function routeConnect(deviceType: FacewearDeviceType): void {
  if (typeof window === "undefined") return;
  if (deviceType === "even-realities") {
    window.location.assign("/apps/smartglasses");
    return;
  }
  window.open("/api/xr/connect", "_blank", "noopener,noreferrer");
}

function openXrPage(path: string): void {
  if (typeof window === "undefined") return;
  window.open(path, "_blank", "noopener,noreferrer");
}

export function FacewearView() {
  const [devices, setDevices] = useState<ConnectedDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/facewear/status");
      if (res.ok) {
        const data = (await res.json()) as FacewearStatusResponse;
        setDevices(data.devices);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on mount, then keep fresh with a quiet 5s poll. Torn down on unmount.
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (!autoLoadedRef.current) {
      autoLoadedRef.current = true;
      void fetchStatus();
    }
    const interval = setInterval(() => void fetchStatus(), 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("connect:")) {
        routeConnect(action.slice("connect:".length) as FacewearDeviceType);
        return;
      }
      switch (action) {
        case "refresh":
          void fetchStatus();
          return;
        case "xr-connect":
          openXrPage("/api/xr/connect");
          return;
        case "xr-status":
          openXrPage("/api/xr/status");
          return;
      }
    },
    [fetchStatus],
  );

  const snapshot: FacewearSnapshot = {
    profiles: FACEWEAR_DEVICE_PROFILES.map((profile) => ({
      type: profile.type,
      name: profile.name,
      manufacturer: profile.manufacturer,
      connectionType: profile.connectionType,
      connected: isProfileConnected(profile, devices),
    })),
    devices,
    connectedCount: devices.length,
    loading,
    error,
  };

  return (
    <SpatialSurface>
      <FacewearSpatialView snapshot={snapshot} onAction={onAction} />
    </SpatialSurface>
  );
}
