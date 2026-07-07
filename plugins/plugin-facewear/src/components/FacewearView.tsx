/**
 * FacewearView — the data wrapper for the Facewear surface.
 *
 * It owns the live device data (status fetch + 5s poll, connect routing, XR
 * connect/status links, refresh) and renders the one presentational
 * {@link FacewearSpatialView} inside a {@link SpatialSurface}.
 *
 * This wrapper is the single Facewear surface, consumed by the Settings →
 * Wearables section (`register.ts`).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { FacewearDeviceType } from "../devices/registry.ts";
import type {
	OpenXrInstallPlan,
	OpenXrRuntimeStatus,
} from "../runtime/openxr-runtime.ts";
import {
	type FacewearSnapshot,
	FacewearSpatialView,
	type FacewearXrRuntimeRow,
} from "./FacewearSpatialView.tsx";
import {
	type ConnectedDevice,
	FACEWEAR_DEVICE_PROFILES,
	type FacewearStatusResponse,
	isProfileConnected,
} from "./facewear-profiles.ts";

/** Route a connect/manage request from the Settings → Wearables host. */
function routeConnect(deviceType: FacewearDeviceType): void {
	if (typeof window === "undefined") return;
	if (deviceType === "even-realities") {
		// Smartglasses is now a sibling tab in the Wearables settings section, not a
		// standalone route — ask the host section to switch to it.
		window.dispatchEvent(
			new CustomEvent("wearables:select-tab", { detail: "smartglasses" }),
		);
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
	const [xrRuntime, setXrRuntime] = useState<
		FacewearXrRuntimeRow | undefined
	>();

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

	const fetchRuntime = useCallback(async (): Promise<void> => {
		try {
			const res = await fetch("/api/facewear/xr-runtime");
			if (!res.ok) return;
			const { status, plan } = (await res.json()) as {
				status: OpenXrRuntimeStatus;
				plan: OpenXrInstallPlan;
			};
			setXrRuntime({
				installed: status.installed,
				runtime: status.runtime,
				webxrReady: status.webxrReady,
				platform: status.platform,
				setupUrl: plan.steps.find((s) => s.url)?.url,
			});
		} catch {
			// Runtime probe is best-effort; the row simply stays hidden if it fails.
		}
	}, []);

	// Load on mount, then keep fresh with a quiet 5s poll. Torn down on unmount.
	const autoLoadedRef = useRef(false);
	useEffect(() => {
		if (!autoLoadedRef.current) {
			autoLoadedRef.current = true;
			void fetchStatus();
			void fetchRuntime();
		}
		const interval = setInterval(() => void fetchStatus(), 5000);
		return () => clearInterval(interval);
	}, [fetchStatus, fetchRuntime]);

	const onAction = useCallback(
		(action: string) => {
			if (action.startsWith("connect:")) {
				routeConnect(action.slice("connect:".length) as FacewearDeviceType);
				return;
			}
			switch (action) {
				case "refresh":
					void fetchStatus();
					void fetchRuntime();
					return;
				case "xr-connect":
					openXrPage("/api/xr/connect");
					return;
				case "xr-status":
					openXrPage("/api/xr/status");
					return;
				case "xr-runtime-setup":
					// Open the first actionable install page (SteamVR), else the raw
					// runtime report so the operator can see the full plan + commands.
					openXrPage(xrRuntime?.setupUrl ?? "/api/facewear/xr-runtime");
					return;
			}
		},
		[fetchStatus, fetchRuntime, xrRuntime],
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
		xrRuntime,
		loading,
		error,
	};

	return <FacewearSpatialView snapshot={snapshot} onAction={onAction} />;
}
