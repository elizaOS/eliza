/**
 * Node.js-specific utilities that should not be imported in browser environments
 */

import { getEnv } from "./environment";

export function getLocalServerUrl(path: string): string {
	// ELIZA_API_PORT and ELIZA_PORT identify the app listener; SERVER_PORT is the standalone
	// fallback.
	const port =
		getEnv("ELIZA_API_PORT") ??
		getEnv("ELIZA_PORT") ??
		getEnv("SERVER_PORT", "3000");
	const normalizedPath = path && !path.startsWith("/") ? `/${path}` : path;
	return `http://localhost:${port}${normalizedPath}`;
}

// Re-export Node-specific utilities
export * from "./paths";
