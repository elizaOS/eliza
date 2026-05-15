/**
 * Forward request body pipeline. Mirrors processBody() in proxy.js v2.2.3
 * layer-by-layer, in the same order, with the same string operations.
 *
 * Layers (in processing order):
 *   2. String trigger sanitization       (sanitize.ts)
 *   3. Tool name renames                 (tool-rename.ts)
 *   6. Property name renames             (property-rename.ts)
 *   4. System prompt template strip      (system-prompt.ts)
 *   5. Tool description strip + stubs    (cc-tool-stubs.ts)
 *   1. Billing fingerprint injection     (billing-fingerprint.ts)
 *   metadata injection (device_id + session_id)
 *   8. Strip trailing assistant prefill
 *   9. Strip thinking blocks
 */

import { randomBytes, randomUUID } from "node:crypto";
import { buildBillingBlock } from "./billing-fingerprint.js";
import { processToolsSection } from "./cc-tool-stubs.js";
import type { Pair } from "./sanitize.js";
import { applyReplacements } from "./sanitize.js";
import { stripSystemConfig } from "./system-prompt.js";
import { applyQuotedRenames } from "./tool-rename.js";

export interface ProcessBodyConfig {
	replacements: ReadonlyArray<Pair>;
	toolRenames: ReadonlyArray<Pair>;
	propRenames: ReadonlyArray<Pair>;
	stripSystemConfig?: boolean;
	stripToolDescriptions?: boolean;
	injectCCStubs?: boolean;
	stripTrailingAssistantPrefill?: boolean;
	stripThinkingBlocks?: boolean;
	deviceId?: string;
	sessionId?: string;
}

// Generated once at module load — matches proxy.js's per-process identifiers.
export const DEVICE_ID = randomBytes(32).toString("hex");
export const INSTANCE_SESSION_ID = randomUUID();

export interface ProcessBodyResult {
	body: string;
	stats: {
		systemConfigStripped: number;
		descriptionsStripped: number;
		stubsInjected: number;
		assistantPrefillStripped: number;
		thinkingBlocksStripped: number;
		thinkingParamsStripped: number;
	};
}

export function processBody(
	bodyStr: string,
	config: ProcessBodyConfig,
): ProcessBodyResult {
	let m = bodyStr;

	// Layer 2: String trigger sanitization
	m = applyReplacements(m, config.replacements);

	// Layer 3: Tool name fingerprint bypass
	m = applyQuotedRenames(m, config.toolRenames);

	// Layer 6: Property name renaming
	m = applyQuotedRenames(m, config.propRenames);

	// Layer 4: System prompt template bypass
	let systemConfigStripped = 0;
	if (config.stripSystemConfig !== false) {
		const r = stripSystemConfig(m);
		m = r.body;
		systemConfigStripped = r.stripped;
	}

	// Layer 5: Tool description stripping + Layer 5b: CC stubs
	const toolResult = processToolsSection(
		m,
		config.stripToolDescriptions !== false,
		config.injectCCStubs !== false,
	);
	m = toolResult.body;

	// Layer 1: Billing header injection (dynamic fingerprint per request)
	const billingBlock = buildBillingBlock(m);
	const sysArrayIdx = m.indexOf('"system":[');
	if (sysArrayIdx !== -1) {
		const insertAt = sysArrayIdx + '"system":['.length;
		m = `${m.slice(0, insertAt)}${billingBlock},${m.slice(insertAt)}`;
	} else if (m.includes('"system":"')) {
		const sysStart = m.indexOf('"system":"');
		let i = sysStart + '"system":"'.length;
		while (i < m.length) {
			if (m[i] === "\\") {
				i += 2;
				continue;
			}
			if (m[i] === '"') break;
			i++;
		}
		const sysEnd = i + 1;
		const originalSysStr = m.slice(sysStart + '"system":'.length, sysEnd);
		m =
			m.slice(0, sysStart) +
			'"system":[' +
			billingBlock +
			',{"type":"text","text":' +
			originalSysStr +
			"}]" +
			m.slice(sysEnd);
	} else {
		m = `{"system":[${billingBlock}],` + m.slice(1);
	}

	// Metadata injection: device_id + session_id matching real CC format
	const deviceId = config.deviceId ?? DEVICE_ID;
	const sessionId = config.sessionId ?? INSTANCE_SESSION_ID;
	const metaValue = JSON.stringify({
		device_id: deviceId,
		session_id: sessionId,
	});
	const metaJson = `"metadata":{"user_id":${JSON.stringify(metaValue)}}`;
	const existingMeta = m.indexOf('"metadata":{');
	if (existingMeta !== -1) {
		let depth = 0;
		let mi = existingMeta + '"metadata":'.length;
		for (; mi < m.length; mi++) {
			if (m[mi] === "{") depth++;
			else if (m[mi] === "}") {
				depth--;
				if (depth === 0) {
					mi++;
					break;
				}
			}
		}
		m = m.slice(0, existingMeta) + metaJson + m.slice(mi);
	} else {
		m = "{" + metaJson + "," + m.slice(1);
	}

	// Layer 8: Strip trailing assistant prefill
	let assistantPrefillStripped = 0;
	if (config.stripTrailingAssistantPrefill !== false) {
		const msgsIdx = m.indexOf('"messages":[');
		if (msgsIdx !== -1) {
			const arrayStart = msgsIdx + '"messages":['.length;
			const positions: { start: number; end: number }[] = [];
			let depth = 0;
			let inString = false;
			let objStart = -1;
			for (let i = arrayStart; i < m.length; i++) {
				const c = m[i];
				if (inString) {
					if (c === "\\") {
						i++;
						continue;
					}
					if (c === '"') inString = false;
					continue;
				}
				if (c === '"') {
					inString = true;
					continue;
				}
				if (c === "{") {
					if (depth === 0) objStart = i;
					depth++;
				} else if (c === "}") {
					depth--;
					if (depth === 0 && objStart !== -1) {
						positions.push({ start: objStart, end: i });
						objStart = -1;
					}
				} else if (c === "]" && depth === 0) {
					break;
				}
			}
			while (positions.length > 0) {
				const last = positions[positions.length - 1]!;
				const obj = m.slice(last.start, last.end + 1);
				if (!obj.includes('"role":"assistant"')) break;
				let stripFrom = last.start;
				for (let i = last.start - 1; i >= arrayStart; i--) {
					if (m[i] === ",") {
						stripFrom = i;
						break;
					}
					if (m[i] !== " " && m[i] !== "\n" && m[i] !== "\r" && m[i] !== "\t")
						break;
				}
				m = m.slice(0, stripFrom) + m.slice(last.end + 1);
				positions.pop();
				assistantPrefillStripped++;
			}
		}
	}

	// Layer 9: Strip thinking blocks
	let thinkingBlocksStripped = 0;
	let thinkingParamsStripped = 0;
	if (config.stripThinkingBlocks !== false) {
		const thinkingParamRegex = /,?"thinking":\s*\{[^}]*\}/g;
		const thinkingMatches = m.match(thinkingParamRegex);
		if (thinkingMatches) {
			m = m.replace(thinkingParamRegex, "");
			thinkingParamsStripped = thinkingMatches.length;
		}
		const msgsIdx2 = m.indexOf('"messages":[');
		if (msgsIdx2 !== -1) {
			for (const marker of [
				'{"type":"thinking"',
				'{"type":"redacted_thinking"',
			]) {
				let searchFrom = msgsIdx2;
				while (true) {
					const idx = m.indexOf(marker, searchFrom);
					if (idx === -1) break;
					let depth = 0;
					let inStr = false;
					let end = -1;
					for (let i = idx; i < m.length; i++) {
						const c = m[i];
						if (inStr) {
							if (c === "\\") {
								i++;
								continue;
							}
							if (c === '"') inStr = false;
							continue;
						}
						if (c === '"') {
							inStr = true;
							continue;
						}
						if (c === "{") depth++;
						else if (c === "}") {
							depth--;
							if (depth === 0) {
								end = i;
								break;
							}
						}
					}
					if (end === -1) break;
					let stripStart = idx;
					let stripEnd = end + 1;
					if (m[stripEnd] === ",") stripEnd++;
					else if (m[stripStart - 1] === ",") stripStart--;
					m = m.slice(0, stripStart) + m.slice(stripEnd);
					thinkingBlocksStripped++;
					searchFrom = stripStart;
				}
			}
		}
	}

	return {
		body: m,
		stats: {
			systemConfigStripped,
			descriptionsStripped: toolResult.descriptionsStripped,
			stubsInjected: toolResult.stubsInjected,
			assistantPrefillStripped,
			thinkingBlocksStripped,
			thinkingParamsStripped,
		},
	};
}
