/**
 * Node.js-specific utilities that should not be imported in browser environments
 * Import directly from ./paths and ./server-health
 */

import { getEnv } from "./environment";

export function getLocalServerUrl(path: string): string {
	const port = getEnv("SERVER_PORT", "3000");
	return `http://localhost:${port}${path}`;
}

// Re-export Node-specific utilities
export * from "./paths";
export * from "./server-health";
