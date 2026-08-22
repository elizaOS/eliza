/** Caller-scoped handoff from app launch results into Eliza's in-app Browser. */

import { randomUUID } from "node:crypto";
import type { Memory } from "@elizaos/core";
import { REALTIME_VOICE_CLIENT_TRANSPORT } from "@elizaos/shared";
import { navigateToView } from "../actions/views-show.js";
import { getAppControlApiBase } from "../loopback-api.js";

export function browserViewPathForLaunchUrl(launchUrl: string): string {
	if (launchUrl.startsWith("/api/apps/local/")) {
		return `/browser?browse=${encodeURIComponent(launchUrl)}`;
	}
	const absoluteUrl = new URL(
		launchUrl,
		`${getAppControlApiBase()}/`,
	).toString();
	return `/browser?browse=${encodeURIComponent(absoluteUrl)}`;
}

const SAFE_VIEW_CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function appLaunchViewClientId(message: Memory): string | undefined {
	const metadata = message.content.metadata;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return undefined;
	}
	const clientId = (metadata as Record<string, unknown>).viewClientId;
	return typeof clientId === "string" && SAFE_VIEW_CLIENT_ID.test(clientId)
		? clientId
		: undefined;
}

export function isRealtimeVoiceAppLaunch(message: Memory): boolean {
	const metadata = message.content.metadata;
	return (
		typeof metadata === "object" &&
		metadata !== null &&
		!Array.isArray(metadata) &&
		(metadata as Record<string, unknown>).clientTransport ===
			REALTIME_VOICE_CLIENT_TRANSPORT
	);
}

export interface BrowserViewNavigationResult {
	path: string;
	status: "delivered" | "fallback" | "unavailable";
	completedActionDelivered: boolean;
	completedActionHandoffId?: string;
	errorCode?:
		| "NO_ORIGINATING_CLIENT"
		| "INVALID_LAUNCH_URL"
		| "RENDERER_UNAVAILABLE"
		| "INVALID_RECEIPT"
		| "NAVIGATION_REJECTED"
		| "TRANSPORT_FAILURE";
}

export async function openLaunchUrlInBrowserView(
	launchUrl: string,
	options: {
		originatingClientId?: string;
		realtimeVoice?: boolean;
		completedActionHandoffId?: string;
	} = {},
): Promise<BrowserViewNavigationResult> {
	let path: string;
	try {
		path = browserViewPathForLaunchUrl(launchUrl);
	} catch (error) {
		// error-policy:J4 malformed launch receipts become an explicit unavailable
		// result so the action can retain the raw link without claiming navigation.
		void error;
		return {
			path: "/browser",
			status: "unavailable",
			completedActionDelivered: false,
			errorCode: "INVALID_LAUNCH_URL",
		};
	}
	const originatingClientId = options.originatingClientId;
	if (!originatingClientId || !SAFE_VIEW_CLIENT_ID.test(originatingClientId)) {
		return {
			path,
			status: "unavailable",
			completedActionDelivered: false,
			errorCode: "NO_ORIGINATING_CLIENT",
		};
	}
	const delivery = options.realtimeVoice
		? "originating-client"
		: "completed-action";
	const completedActionHandoffId = options.realtimeVoice
		? undefined
		: (options.completedActionHandoffId ?? randomUUID());
	const result = await navigateToView(
		{
			id: "browser",
			label: "Browser",
			pluginName: "plugin-app-control",
			path,
			viewType: "gui",
			available: true,
		},
		"gui",
		undefined,
		"Browser",
		delivery,
		originatingClientId,
		completedActionHandoffId,
	);
	if (!result.ok) {
		return {
			path,
			status: "unavailable",
			completedActionDelivered: false,
			errorCode:
				result.failureKind === "transport"
					? "TRANSPORT_FAILURE"
					: result.failureKind === "navigation-rejected"
						? "NAVIGATION_REJECTED"
						: "RENDERER_UNAVAILABLE",
		};
	}
	if (options.realtimeVoice) {
		return { path, status: "delivered", completedActionDelivered: true };
	}
	const handoffEchoed =
		result.completedActionHandoffId === completedActionHandoffId;
	const delivered = result.completedActionDelivered === true && handoffEchoed;
	return {
		path,
		status: delivered
			? "delivered"
			: handoffEchoed
				? "fallback"
				: "unavailable",
		completedActionDelivered: delivered,
		...(handoffEchoed && completedActionHandoffId
			? { completedActionHandoffId }
			: {}),
		...(!handoffEchoed ? { errorCode: "INVALID_RECEIPT" as const } : {}),
	};
}
