/**
 * Node.js-specific utilities that should not be imported in browser environments
 * Import directly from ./paths and ./server-health
 */

import { getEnv } from "./environment";

export function getLocalServerUrl(path: string): string {
	// The browser/app host advertises its API listener through ELIZA_API_PORT
	// (or the legacy ELIZA_PORT alias). SERVER_PORT remains the standalone
	// server fallback. Using only SERVER_PORT silently sent local attachment
	// enrichment to port 3000 in every custom-port dev/runtime lane.
	const port =
		getEnv("ELIZA_API_PORT") ??
		getEnv("ELIZA_PORT") ??
		getEnv("SERVER_PORT", "3000");
	const normalizedPath = path && !path.startsWith("/") ? `/${path}` : path;
	return `http://localhost:${port}${normalizedPath}`;
}

// Re-export Node-specific utilities
export * from "./paths";
export * from "./server-health";
