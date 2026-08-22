/** Delivers launched-app URLs to the Browser view owned by the requesting renderer. */

import { randomUUID } from "node:crypto";
import type { Memory } from "@elizaos/core";
import {
	isRealtimeVoiceTurn,
	readViewInteractionClientId,
} from "../actions/view-delivery.js";
import { navigateToView } from "../actions/views-show.js";
import { getAppControlApiBase } from "../loopback-api.js";

export type BrowserNavigationStatus =
	| "renderer-delivered"
	| "terminal-fallback"
	| "target-unavailable"
	| "invalid-url";

export interface BrowserNavigationResult {
	status: BrowserNavigationStatus;
	openedInBrowser: boolean;
	viewPath?: string;
	completedActionDelivered?: true;
	completedActionHandoffId?: string;
	navigationFailure?:
		| "unsupported-route"
		| "http-error"
		| "transport-error"
		| "malformed-receipt";
}

function navigationFailure(
	status: Awaited<ReturnType<typeof navigateToView>>["status"],
): BrowserNavigationResult["navigationFailure"] {
	return status === "accepted" ? undefined : status;
}

export function browserViewPathForLaunchUrl(launchUrl: string): string {
	if (launchUrl.startsWith("/api/apps/local/")) {
		return `/browser?browse=${encodeURIComponent(launchUrl)}`;
	}
	const absoluteUrl = new URL(launchUrl, `${getAppControlApiBase()}/`);
	if (absoluteUrl.protocol !== "http:" && absoluteUrl.protocol !== "https:") {
		throw new TypeError("Unsupported app launch URL protocol");
	}
	return `/browser?browse=${encodeURIComponent(absoluteUrl.toString())}`;
}

export async function openLaunchUrlInBrowserView(
	launchUrl: string,
	message: Memory,
): Promise<BrowserNavigationResult> {
	let viewPath: string;
	try {
		viewPath = browserViewPathForLaunchUrl(launchUrl);
	} catch {
		// error-policy:J3 an invalid launch URL becomes an explicit typed result;
		// it is never sent to a renderer or disguised as successful navigation.
		return { status: "invalid-url", openedInBrowser: false };
	}

	const originatingClientId = readViewInteractionClientId(message);
	const voiceTurn = isRealtimeVoiceTurn(message);
	if (!originatingClientId) {
		if (voiceTurn) {
			return {
				status: "target-unavailable",
				openedInBrowser: false,
				viewPath,
			};
		}
		return {
			status: "terminal-fallback",
			openedInBrowser: false,
			viewPath,
			completedActionHandoffId: randomUUID(),
		};
	}

	const completedActionHandoffId = voiceTurn ? undefined : randomUUID();
	const navigation = await navigateToView(
		{
			id: "browser",
			label: "Browser",
			path: viewPath,
			pluginName: "@elizaos/builtin",
			available: true,
			viewType: "gui",
		},
		"gui",
		undefined,
		"Browser",
		voiceTurn ? "originating-client" : "completed-action",
		originatingClientId,
		completedActionHandoffId,
	);

	if (voiceTurn) {
		const failure = navigationFailure(navigation.status);
		return {
			status: navigation.ok ? "renderer-delivered" : "target-unavailable",
			openedInBrowser: navigation.ok,
			viewPath,
			...(!navigation.ok && failure ? { navigationFailure: failure } : {}),
		};
	}

	const delivered = navigation.receiptStatus === "delivered";
	const failure = navigationFailure(navigation.status);
	return {
		status: delivered ? "renderer-delivered" : "terminal-fallback",
		openedInBrowser: delivered,
		viewPath,
		...(delivered ? { completedActionDelivered: true as const } : {}),
		...(completedActionHandoffId ? { completedActionHandoffId } : {}),
		...(navigation.receiptStatus === "malformed"
			? { navigationFailure: "malformed-receipt" as const }
			: !navigation.ok && failure
				? { navigationFailure: failure }
				: {}),
	};
}
