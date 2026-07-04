/**
 * Service contract for the mobile-device inference bridge — the host that
 * relays on-device GPU inference (llama.cpp over Metal / Vulkan / GPU-delegate)
 * to a paired phone. Defines the status DTO and the abstract
 * {@link MobileDeviceBridgeService} that a mobile-host plugin subclasses and
 * registers through the normal service registry, keyed by
 * {@link ServiceType.MOBILE_DEVICE_BRIDGE}; consumers resolve it via
 * `runtime.getService`.
 */
import { Service, ServiceType } from "./types/service";

/**
 * Status snapshot of the mobile-device inference bridge (the host that relays
 * on-device GPU inference to a paired phone).
 *
 * This is the single canonical definition of the bridge contract. The mobile
 * host implements it as a runtime {@link MobileDeviceBridgeService}; consumers
 * read it back via `runtime.getService(ServiceType.MOBILE_DEVICE_BRIDGE)`.
 */
export interface MobileDeviceBridgeStatus {
	enabled: boolean;
	connected: boolean;
	devices: Array<{
		deviceId: string;
		capabilities: {
			platform: "ios" | "android" | "web";
			deviceModel: string;
			totalRamGb: number;
			cpuCores: number;
			gpu: {
				backend: "metal" | "vulkan" | "gpu-delegate";
				available: boolean;
			} | null;
		};
		loadedPath: string | null;
		connectedSince: string;
	}>;
	primaryDeviceId: string | null;
	pendingRequests: number;
	modelPath: string | null;
}

/**
 * Runtime service contract for the mobile device bridge.
 *
 * The mobile host (e.g. `@elizaos/plugin-capacitor-bridge`) registers a
 * concrete subclass via a plugin `services` array; consumers resolve it with
 * `runtime.getService<MobileDeviceBridgeService>(ServiceType.MOBILE_DEVICE_BRIDGE)`.
 * There is no global/`Symbol.for` slot — registration flows through the normal
 * service registry so it is typed, per-runtime, and never last-writer-wins.
 */
export abstract class MobileDeviceBridgeService extends Service {
	static override serviceType: typeof ServiceType.MOBILE_DEVICE_BRIDGE =
		ServiceType.MOBILE_DEVICE_BRIDGE;

	abstract getMobileDeviceBridgeStatus(): MobileDeviceBridgeStatus;

	abstract loadMobileDeviceBridgeModel(
		modelPath: string,
		modelId?: string,
	): Promise<void>;

	abstract unloadMobileDeviceBridgeModel(): Promise<void>;
}
