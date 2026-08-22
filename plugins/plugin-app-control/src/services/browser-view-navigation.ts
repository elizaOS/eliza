/** Delivers launched-app URLs to the Browser view owned by the requesting renderer. */

import { randomUUID } from "node:crypto";
import type { Memory } from "@elizaos/core";
import {
	isRealtimeVoiceTurn,
	readViewInteractionClientId,
} from "../actions/view-delivery.js";
import { navigateToView } from "../actions/views-show.js";

export type BrowserNavigationStatus =
	| "renderer-delivered"
	| "terminal-fallback"
	| "target-unavailable"
	| "invalid-url";

export interface BrowserNavigationResult {
	status: BrowserNavigationStatus;
	openedInBrowser: boolean;
	/** Canonical http(s) target safe to expose to the model or renderer. */
	safeLaunchUrl?: string;
	/** Same target escaped for a Markdown link destination. */
	safeMarkdownLaunchUrl?: string;
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
	if (launchUrl.startsWith("/")) {
		const relativeBase = "https://relative.invalid/";
		const parsed = new URL(launchUrl, relativeBase);
		if (parsed.origin !== new URL(relativeBase).origin) {
			throw new TypeError("Unsupported network-path app launch URL");
		}
		if (!parsed.pathname.startsWith("/api/apps/local/")) {
			throw new TypeError("Unsupported relative app launch URL");
		}
		const relativeUrl = `${parsed.pathname}${parsed.search}${parsed.hash}`;
		return `/browser?browse=${encodeURIComponent(relativeUrl)}`;
	}
	const absoluteUrl = new URL(launchUrl);
	if (absoluteUrl.protocol !== "http:" && absoluteUrl.protocol !== "https:") {
		throw new TypeError("Unsupported app launch URL protocol");
	}
	return `/browser?browse=${encodeURIComponent(absoluteUrl.toString())}`;
}

function markdownSafeHref(url: string): string {
	return url.replace(/\\/g, "%5C").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

export async function openLaunchUrlInBrowserView(
	launchUrl: string,
	message: Memory,
): Promise<BrowserNavigationResult> {
	let viewPath: string;
	let safeLaunchUrl: string;
	let safeMarkdownLaunchUrl: string;
	try {
		viewPath = browserViewPathForLaunchUrl(launchUrl);
		safeLaunchUrl =
			new URLSearchParams(viewPath.slice(viewPath.indexOf("?") + 1)).get(
				"browse",
			) ?? "";
		if (!safeLaunchUrl) throw new TypeError("Missing Browser launch target");
		safeMarkdownLaunchUrl = markdownSafeHref(safeLaunchUrl);
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
				safeLaunchUrl,
				safeMarkdownLaunchUrl,
			};
		}
		return {
			status: "terminal-fallback",
			openedInBrowser: false,
			viewPath,
			safeLaunchUrl,
			safeMarkdownLaunchUrl,
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
			safeLaunchUrl,
			safeMarkdownLaunchUrl,
			...(!navigation.ok && failure ? { navigationFailure: failure } : {}),
		};
	}

	const delivered = navigation.receiptStatus === "delivered";
	const failure = navigationFailure(navigation.status);
	return {
		status: delivered ? "renderer-delivered" : "terminal-fallback",
		openedInBrowser: delivered,
		viewPath,
		safeLaunchUrl,
		safeMarkdownLaunchUrl,
		...(delivered ? { completedActionDelivered: true as const } : {}),
		...(completedActionHandoffId ? { completedActionHandoffId } : {}),
		...(navigation.receiptStatus === "malformed"
			? { navigationFailure: "malformed-receipt" as const }
			: !navigation.ok && failure
				? { navigationFailure: failure }
				: {}),
	};
}
