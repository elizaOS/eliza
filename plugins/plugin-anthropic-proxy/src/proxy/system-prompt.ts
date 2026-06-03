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
 * For non-eliza framework agents, the strip silently no-ops when the marker
 * isn't present. A proxy config can supply alternate start/end anchors and
 * paraphrase text for another framework's recurring system-prompt block.
 */

import { SYSTEM_CONFIG_PARAPHRASE } from "./constants.js";
import {
  ELIZA_BOUNDARY_END,
  ELIZA_IDENTITY_MARKER,
} from "./eliza-fingerprint.js";

const MIN_STRIP_LEN = 200;

export interface SystemPromptStripConfig {
  start: string;
  end: string;
  paraphrase: string;
  minStripLen?: number;
}

export function stripSystemConfig(m: string): {
  body: string;
  stripped: number;
};
export function stripSystemConfig(
  m: string,
  config: SystemPromptStripConfig,
): {
  body: string;
  stripped: number;
};
export function stripSystemConfig(
  m: string,
  config?: SystemPromptStripConfig,
): {
  body: string;
  stripped: number;
} {
  const startMarker = config?.start ?? ELIZA_IDENTITY_MARKER;
  const endMarker = config?.end ?? ELIZA_BOUNDARY_END;
  const paraphrase = config?.paraphrase ?? SYSTEM_CONFIG_PARAPHRASE;
  const minStripLen = config?.minStripLen ?? MIN_STRIP_LEN;

  const sysArrayStart = m.indexOf('"system":[');
  const searchFrom = sysArrayStart !== -1 ? sysArrayStart : 0;
  const configStart = m.indexOf(startMarker, searchFrom);
  if (configStart === -1) return { body: m, stripped: 0 };

  let stripFrom = configStart;
  if (stripFrom >= 2 && m[stripFrom - 2] === "\\" && m[stripFrom - 1] === "n") {
    stripFrom -= 2;
  }

  const boundaryStart = m.indexOf(
    endMarker,
    configStart + startMarker.length,
  );
  if (boundaryStart === -1) return { body: m, stripped: 0 };

  const configEnd = boundaryStart + endMarker.length;
  const strippedLen = configEnd - stripFrom;
  if (strippedLen <= minStripLen) return { body: m, stripped: 0 };

  return {
    body: m.slice(0, stripFrom) + paraphrase + m.slice(configEnd),
    stripped: strippedLen,
  };
}
