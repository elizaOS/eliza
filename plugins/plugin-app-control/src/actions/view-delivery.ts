/** Identifies the renderer-owned delivery channel for view navigation actions. */

import type { Memory } from "@elizaos/core";
import { REALTIME_VOICE_CLIENT_TRANSPORT } from "@elizaos/shared";

const SAFE_VIEW_CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function readViewInteractionClientId(
	message: Memory,
): string | undefined {
	const metadata = message.content.metadata;
	if (
		typeof metadata !== "object" ||
		metadata === null ||
		Array.isArray(metadata)
	) {
		return undefined;
	}
	const clientId = (metadata as Record<string, unknown>).viewClientId;
	return typeof clientId === "string" && SAFE_VIEW_CLIENT_ID.test(clientId)
		? clientId
		: undefined;
}

export function isRealtimeVoiceTurn(message: Memory): boolean {
	const metadata = message.content.metadata;
	return (
		typeof metadata === "object" &&
		metadata !== null &&
		!Array.isArray(metadata) &&
		(metadata as Record<string, unknown>).clientTransport ===
			REALTIME_VOICE_CLIENT_TRANSPORT
	);
}
