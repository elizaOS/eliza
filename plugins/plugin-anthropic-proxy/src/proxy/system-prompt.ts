/**
 * Layer 4: System prompt template bypass.
 *
 * Strips the OC config section (~28K of `## Tooling`, `## Workspace`,
 * `## Messaging`, etc.) and replaces with a brief paraphrase. The config is
 * between the identity line ("You are a personal assistant") and the first
 * workspace doc (path-prefixed `## ` header).
 *
 * Anchors search to the system array so we don't match conversation history.
 */

import { SYSTEM_CONFIG_PARAPHRASE } from "./constants.js";

const IDENTITY_MARKER = "You are a personal assistant";
const MIN_STRIP_LEN = 1000;

export function stripSystemConfig(m: string): {
	body: string;
	stripped: number;
} {
	const sysArrayStart = m.indexOf('"system":[');
	const searchFrom = sysArrayStart !== -1 ? sysArrayStart : 0;
	const configStart = m.indexOf(IDENTITY_MARKER, searchFrom);
	if (configStart === -1) return { body: m, stripped: 0 };

	let stripFrom = configStart;
	if (stripFrom >= 2 && m[stripFrom - 2] === "\\" && m[stripFrom - 1] === "n") {
		stripFrom -= 2;
	}

	// Find end of config: first workspace doc header (path-prefixed `## `).
	// Linux/macOS: \n## /home/... or \n## /Users/...
	// Windows:     \n## C:\\...
	let configEnd = m.indexOf("\\n## /", configStart + IDENTITY_MARKER.length);
	if (configEnd === -1) {
		configEnd = m.indexOf(
			"\\n## C:\\\\",
			configStart + IDENTITY_MARKER.length,
		);
	}
	if (configEnd === -1) return { body: m, stripped: 0 };

	const boundary = configEnd;
	const strippedLen = boundary - stripFrom;
	if (strippedLen <= MIN_STRIP_LEN) return { body: m, stripped: 0 };

	return {
		body: m.slice(0, stripFrom) + SYSTEM_CONFIG_PARAPHRASE + m.slice(boundary),
		stripped: strippedLen,
	};
}
