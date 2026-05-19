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

export interface MobileDeviceBridgeHooks {
	getMobileDeviceBridgeStatus(): MobileDeviceBridgeStatus;
	loadMobileDeviceBridgeModel(
		modelPath: string,
		modelId?: string,
	): Promise<void>;
	unloadMobileDeviceBridgeModel(): Promise<void>;
}

const MOBILE_DEVICE_BRIDGE_HOOKS = Symbol.for(
	"elizaos.mobile-device-bridge.hooks",
);

type MobileDeviceBridgeHooksGlobal = typeof globalThis & {
	[MOBILE_DEVICE_BRIDGE_HOOKS]?: MobileDeviceBridgeHooks;
};

function hooksGlobal(): MobileDeviceBridgeHooksGlobal {
	return globalThis as MobileDeviceBridgeHooksGlobal;
}

export function registerMobileDeviceBridgeHooks(
	hooks: MobileDeviceBridgeHooks,
): void {
	hooksGlobal()[MOBILE_DEVICE_BRIDGE_HOOKS] = hooks;
}

export function getMobileDeviceBridgeHooks(): MobileDeviceBridgeHooks | null {
	return hooksGlobal()[MOBILE_DEVICE_BRIDGE_HOOKS] ?? null;
}
