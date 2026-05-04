import type { SendToWebview } from "../types.js";

interface GeoPosition {
	latitude: number;
	longitude: number;
	accuracy: number;
	timestamp: number;
}

const IP_GEO_SERVICES = [
	"http://ip-api.com/json/?fields=lat,lon,status",
	"https://ipapi.co/json/",
];

/**
 * Reported accuracy (meters) for the IP-geolocation desktop fallback.
 *
 * IP-based lookup typically resolves to a city centroid — accurate to
 * roughly 5 km in the median case for residential ISPs and worse on
 * mobile/VPN networks. We surface 5000 m so downstream consumers (the
 * travel-time fallback, the Location plugin's `accuracy` contract, and
 * any UI that gates behavior on accuracy) treat this fix as coarse and
 * never confuse it with a real GPS reading.
 *
 * Replace with a tighter floor only when wiring up Mac Core Location via
 * the Swift shell.
 */
const IP_GEO_ACCURACY_METERS = 5000;

export class LocationManager {
	private sendToWebview: SendToWebview | null = null;
	private lastKnown: GeoPosition | null = null;
	private watchIntervals: Map<string, ReturnType<typeof setInterval>> =
		new Map();
	private watchCounter = 0;

	setSendToWebview(fn: SendToWebview): void {
		this.sendToWebview = fn;
	}

	async getCurrentPosition(): Promise<GeoPosition | null> {
		for (const url of IP_GEO_SERVICES) {
			try {
				const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
				if (!resp.ok) continue;
				const data = await resp.json();

				const lat = data.lat ?? data.latitude;
				const lon = data.lon ?? data.longitude;
				if (typeof lat !== "number" || typeof lon !== "number") continue;

				const position: GeoPosition = {
					latitude: lat,
					longitude: lon,
					accuracy: IP_GEO_ACCURACY_METERS,
					timestamp: Date.now(),
				};
				this.lastKnown = position;
				return position;
			} catch {}
		}
		return null;
	}

	async watchPosition(options?: {
		interval?: number;
	}): Promise<{ watchId: string }> {
		const watchId = `watch_${++this.watchCounter}`;
		const interval = options?.interval ?? 60000; // 1 minute default

		const timer = setInterval(async () => {
			const pos = await this.getCurrentPosition();
			if (pos) {
				this.sendToWebview?.("locationUpdate", pos);
			}
		}, interval);

		this.watchIntervals.set(watchId, timer);
		return { watchId };
	}

	async clearWatch(options: { watchId: string }): Promise<void> {
		const timer = this.watchIntervals.get(options.watchId);
		if (timer) {
			clearInterval(timer);
			this.watchIntervals.delete(options.watchId);
		}
	}

	async getLastKnownLocation(): Promise<GeoPosition | null> {
		return this.lastKnown;
	}

	dispose(): void {
		for (const timer of this.watchIntervals.values()) {
			clearInterval(timer);
		}
		this.watchIntervals.clear();
		this.sendToWebview = null;
	}
}

let locationManager: LocationManager | null = null;

export function getLocationManager(): LocationManager {
	if (!locationManager) {
		locationManager = new LocationManager();
	}
	return locationManager;
}
