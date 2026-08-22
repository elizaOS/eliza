/** Caller-scoped handoff from app launch results into Eliza's in-app Browser. */

import { randomUUID } from "node:crypto";
import type { Memory } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { REALTIME_VOICE_CLIENT_TRANSPORT } from "@elizaos/shared";
import { createViewsRequestHeaders } from "../actions/views-request-auth.js";
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
		| "RENDERER_UNAVAILABLE"
		| "INVALID_RECEIPT"
		| "NAVIGATION_REJECTED"
		| "TRANSPORT_FAILURE";
}

function ownValue(body: object, key: string): unknown {
	return Object.getOwnPropertyDescriptor(body, key)?.value;
}

export async function openLaunchUrlInBrowserView(
	launchUrl: string,
	options: {
		originatingClientId?: string;
		realtimeVoice?: boolean;
		completedActionHandoffId?: string;
	} = {},
): Promise<BrowserViewNavigationResult> {
	const path = browserViewPathForLaunchUrl(launchUrl);
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
	try {
		const response = await fetch(
			`${getAppControlApiBase()}/api/views/browser/navigate`,
			{
				method: "POST",
				headers: createViewsRequestHeaders(),
				body: JSON.stringify({
					path,
					viewType: "gui",
					source: "agent",
					delivery,
					clientId: originatingClientId,
					...(completedActionHandoffId ? { completedActionHandoffId } : {}),
				}),
				signal: AbortSignal.timeout(5_000),
			},
		);
		if (!response.ok) {
			return {
				path,
				status: "unavailable",
				completedActionDelivered: false,
				errorCode:
					response.status === 409
						? "RENDERER_UNAVAILABLE"
						: "NAVIGATION_REJECTED",
			};
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch (error) {
			// error-policy:J3 a malformed server receipt is an explicit unconfirmed
			// result; it must never be promoted to renderer-observed delivery.
			if (!(error instanceof SyntaxError)) throw error;
			return {
				path,
				status: "unavailable",
				completedActionDelivered: false,
				errorCode: "INVALID_RECEIPT",
			};
		}
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return {
				path,
				status: "unavailable",
				completedActionDelivered: false,
				errorCode: "INVALID_RECEIPT",
			};
		}
		if (options.realtimeVoice) {
			return {
				path,
				status: "delivered",
				completedActionDelivered: true,
			};
		}
		const handoffEchoed =
			ownValue(body, "completedActionHandoffId") === completedActionHandoffId;
		const delivered =
			ownValue(body, "completedActionDelivered") === true && handoffEchoed;
		return {
			path,
			status: delivered ? "delivered" : "fallback",
			completedActionDelivered: delivered,
			...(handoffEchoed && completedActionHandoffId
				? { completedActionHandoffId }
				: {}),
			...(!handoffEchoed ? { errorCode: "INVALID_RECEIPT" as const } : {}),
		};
	} catch (err) {
		// error-policy:J4 Browser navigation is an optional user-facing degrade;
		// the action retains the launch link and reports the distinct failure.
		logger.warn(
			`[plugin-app-control] Browser view navigation failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return {
			path,
			status: "unavailable",
			completedActionDelivered: false,
			errorCode: "TRANSPORT_FAILURE",
		};
	}
}
