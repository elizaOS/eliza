declare module "@elizaos/capacitor-llama" {
	export interface DeviceBridgeClientConfig {
		agentUrl: string;
		pairingToken?: string;
		deviceId: string;
		onStateChange?: (
			state: "connecting" | "connected" | "disconnected" | "error",
			detail?: string,
		) => void;
	}

	export class DeviceBridgeClient {
		constructor(config: DeviceBridgeClientConfig);
		start(): void;
		stop(): void;
	}

	export function startDeviceBridgeClient(
		config: DeviceBridgeClientConfig,
	): DeviceBridgeClient;

	export function registerCapacitorLlamaLoader(runtime: {
		registerService?: (name: string, impl: unknown) => unknown;
	}): void;
}
