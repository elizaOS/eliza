/**
 * Layer 4: System prompt template bypass.
 *
 * v0.2.0 targets eliza's CHANNEL_GAG_HARD_RULE block — the most
 * distinctive recurring section in `@elizaos/native-reasoning` system
 * prompts. The block is verbatim on every request and runs ~600 bytes;
 * we paraphrase it down to ~250 bytes while preserving the muting
 * semantics so the model still respects channel gag.
 *
 * The strip is bounded:
 *   - start: ELIZA_IDENTITY_MARKER ("HARD RULE: If a human in this channel...")
 *   - end:   ELIZA_BOUNDARY_END    ("Bots cannot mute or unmute you.")
 *
 * Anchored to the system array so it can never match conversation history
 * by accident.
 *
 * For non-eliza framework agents, the strip silently no-ops (the marker
 * isn't present) — the rest of the pipeline still runs. To strip a
 * different framework's recurring section, override the system-prompt
 * anchors via plugin config (future work).
 */

import {
	ELIZA_BOUNDARY_END,
	ELIZA_IDENTITY_MARKER,
} from "./eliza-fingerprint.js";
import { SYSTEM_CONFIG_PARAPHRASE } from "./constants.js";

const MIN_STRIP_LEN = 200;

export function stripSystemConfig(m: string): {
	body: string;
	stripped: number;
} {
	const sysArrayStart = m.indexOf('"system":[');
	const searchFrom = sysArrayStart !== -1 ? sysArrayStart : 0;
	const configStart = m.indexOf(ELIZA_IDENTITY_MARKER, searchFrom);
	if (configStart === -1) return { body: m, stripped: 0 };

	let stripFrom = configStart;
	if (stripFrom >= 2 && m[stripFrom - 2] === "\\" && m[stripFrom - 1] === "n") {
		stripFrom -= 2;
	}

	const boundaryStart = m.indexOf(
		ELIZA_BOUNDARY_END,
		configStart + ELIZA_IDENTITY_MARKER.length,
	);
	if (boundaryStart === -1) return { body: m, stripped: 0 };

	const configEnd = boundaryStart + ELIZA_BOUNDARY_END.length;
	const strippedLen = configEnd - stripFrom;
	if (strippedLen <= MIN_STRIP_LEN) return { body: m, stripped: 0 };

	return {
		body: m.slice(0, stripFrom) + SYSTEM_CONFIG_PARAPHRASE + m.slice(configEnd),
		stripped: strippedLen,
	};
}
