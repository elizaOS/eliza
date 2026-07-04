/**
 * Facewear context provider injects connected XR headset and smartglasses state
 * into the agent prompt.
 */
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	ProviderValue,
	State,
} from "@elizaos/core";
import type { SmartglassesService } from "../services/smartglasses-service.ts";
import { SMARTGLASSES_SERVICE_NAME } from "../services/smartglasses-service.ts";
import {
	XR_SERVICE_TYPE,
	type XRSessionService,
} from "../services/xr-session-service.ts";

export const facewearContextProvider: Provider = {
	name: "xrContext",
	description:
		"Provides context about connected XR headsets and smartglasses (Quest 3, XReal, Even Realities, Apple Vision Pro)",

	get: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		const xrSvc = runtime.getService<XRSessionService>(XR_SERVICE_TYPE);
		const sgSvc = runtime.getService<SmartglassesService>(
			SMARTGLASSES_SERVICE_NAME,
		);

		const hasXR = xrSvc?.hasActiveConnections() ?? false;
		const hasSmartglasses = sgSvc?.getStatus().connected ?? false;

		if (!hasXR && !hasSmartglasses) return { text: "" };

		const lines: string[] = [];
		const values: Record<string, ProviderValue> = {};

		if (hasXR && xrSvc) {
			const conns = xrSvc.getConnections();
			const deviceList = conns
				.map((c) => {
					const hasFrame = xrSvc.getVisionPipeline().hasRecentFrame(c.id);
					return `${c.deviceType}${hasFrame ? " (camera active)" : ""}`;
				})
				.join(", ");

			lines.push(`[XR devices connected: ${deviceList}]`);
			lines.push(
				`[Audio streaming active — the user is speaking to you via their headset microphone.]`,
			);
			lines.push(
				`[Your text responses will be spoken aloud through the headset via TTS.]`,
			);
			lines.push(
				`[Use XR_QUERY_VISION to describe what the user's camera sees.]`,
			);

			values.xrConnected = true;
			values.xrDevices = conns.map((c) => c.deviceType);
			values.xrConnectionCount = conns.length;
		}

		if (hasSmartglasses && sgSvc) {
			const status = sgSvc.getStatus();
			lines.push(
				`[Smartglasses connected: ${status.transport ?? "unknown transport"}]`,
			);
			if (status.microphoneEnabled) {
				lines.push(`[Smartglasses microphone is active.]`);
			}

			values.smartglassesConnected = true;
			values.smartglassesTransport = status.transport;
			values.smartgrassesMicEnabled = status.microphoneEnabled;
		}

		return {
			text: lines.join("\n"),
			values,
		};
	},
};
