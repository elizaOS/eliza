/**
 * Billing fingerprint computation — Layer 1.
 *
 * Computes a 3-character SHA256 fingerprint hash matching real CC's
 * computeFingerprint() in utils/fingerprint.ts:
 *   SHA256(salt + msg[4] + msg[7] + msg[20] + version)[:3]
 *
 * Applied to the first user message text in the request body.
 */

import { createHash } from "node:crypto";
import {
	BILLING_HASH_INDICES,
	BILLING_HASH_SALT,
	CC_VERSION,
} from "./constants.js";

export function computeBillingFingerprint(firstUserText: string): string {
	const chars = BILLING_HASH_INDICES.map((i) => firstUserText[i] ?? "0").join(
		"",
	);
	const input = `${BILLING_HASH_SALT}${chars}${CC_VERSION}`;
	return createHash("sha256").update(input).digest("hex").slice(0, 3);
}

/**
 * Extract first user message text from the raw body using string scanning.
 * Avoids JSON.parse to preserve raw body integrity.
 */
function extractFirstUserText(bodyStr: string): string {
	// Find first "role":"user" in messages array
	const msgsIdx = bodyStr.indexOf('"messages":[');
	if (msgsIdx === -1) return "";
	const userIdx = bodyStr.indexOf('"role":"user"', msgsIdx);
	if (userIdx === -1) return "";

	// Look for "content" near this role
	const contentIdx = bodyStr.indexOf('"content"', userIdx);
	if (contentIdx === -1 || contentIdx > userIdx + 500) return "";

	const afterContent = bodyStr[contentIdx + '"content"'.length + 1]; // skip the :
	if (afterContent === '"') {
		// Simple string content: "content":"text here"
		const textStart = contentIdx + '"content":"'.length;
		let end = textStart;
		while (end < bodyStr.length) {
			if (bodyStr[end] === "\\") {
				end += 2;
				continue;
			}
			if (bodyStr[end] === '"') break;
			end++;
		}
		return bodyStr
			.slice(textStart, end)
			.replace(/\\n/g, "\n")
			.replace(/\\t/g, "\t")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}
	// Array content: find first text block
	const textIdx = bodyStr.indexOf('"text":"', contentIdx);
	if (textIdx === -1 || textIdx > contentIdx + 2000) return "";
	const textStart = textIdx + '"text":"'.length;
	let end = textStart;
	while (end < bodyStr.length) {
		if (bodyStr[end] === "\\") {
			end += 2;
			continue;
		}
		if (bodyStr[end] === '"') break;
		end++;
	}
	return bodyStr
		.slice(textStart, Math.min(end, textStart + 50))
		.replace(/\\n/g, "\n")
		.replace(/\\t/g, "\t")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");
}

export function buildBillingBlock(bodyStr: string): string {
	const firstText = extractFirstUserText(bodyStr);
	const fingerprint = computeBillingFingerprint(firstText);
	const ccVersion = `${CC_VERSION}.${fingerprint}`;
	return `{"type":"text","text":"x-anthropic-billing-header: cc_version=${ccVersion}; cc_entrypoint=cli; cch=00000;"}`;
}
