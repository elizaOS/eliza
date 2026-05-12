/**
 * Sandbox policy — single source of truth for "may we execute local code on
 * this build?". Consulted by both the agent-orchestrator (which spawns
 * coding CLIs via PTY) and any future code-execution action.
 *
 * Store builds forbid forking arbitrary user-installed binaries; we gate the
 * affected actions off entirely rather than letting them fail at spawn time.
 */

import { getBuildVariant, getDirectDownloadUrl } from "./build-variant.js";

export function isLocalCodeExecutionAllowed(): boolean {
	return getBuildVariant() === "direct";
}

export function buildStoreVariantBlockedMessage(featureLabel: string): string {
	return [
		`${featureLabel} requires the direct download build of Eliza.`,
		`Store-distributed builds run in an OS sandbox that blocks forking user-installed CLIs.`,
		`To use this feature, install from ${getDirectDownloadUrl()}.`,
	].join(" ");
}
