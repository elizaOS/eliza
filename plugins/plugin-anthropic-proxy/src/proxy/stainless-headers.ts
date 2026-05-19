/**
 * Stainless SDK + Claude Code identity headers.
 *
 * Real Claude Code sends these on every request via the Anthropic JS SDK.
 */

import { CC_VERSION } from "./constants.js";
import { INSTANCE_SESSION_ID } from "./process-body.js";

export function getStainlessHeaders(): Record<string, string> {
	const p = process.platform;
	const osName =
		p === "darwin"
			? "macOS"
			: p === "win32"
				? "Windows"
				: p === "linux"
					? "Linux"
					: p;
	const arch =
		process.arch === "x64"
			? "x64"
			: process.arch === "arm64"
				? "arm64"
				: process.arch;
	return {
		"user-agent": `claude-cli/${CC_VERSION} (external, cli)`,
		"x-app": "cli",
		"x-claude-code-session-id": INSTANCE_SESSION_ID,
		"x-stainless-arch": arch,
		"x-stainless-lang": "js",
		"x-stainless-os": osName,
		"x-stainless-package-version": "0.81.0",
		"x-stainless-runtime": "node",
		"x-stainless-runtime-version": process.version,
		"x-stainless-retry-count": "0",
		"x-stainless-timeout": "600",
		"anthropic-dangerous-direct-browser-access": "true",
	};
}
