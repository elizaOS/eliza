/** Canonical handoff from app-control results into Eliza's in-app Browser. */

import { logger } from "@elizaos/core";
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

export async function openLaunchUrlInBrowserView(
	launchUrl: string,
): Promise<boolean> {
	try {
		const response = await fetch(
			`${getAppControlApiBase()}/api/views/browser/navigate`,
			{
				method: "POST",
				headers: createViewsRequestHeaders(),
				body: JSON.stringify({
					path: browserViewPathForLaunchUrl(launchUrl),
					viewType: "gui",
					source: "agent",
				}),
				signal: AbortSignal.timeout(5_000),
			},
		);
		return response.ok;
	} catch (err) {
		logger.warn(
			`[plugin-app-control] Browser view navigation failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
}
