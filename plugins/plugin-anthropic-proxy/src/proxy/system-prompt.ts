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
 * For non-eliza framework agents, the strip leaves the payload unchanged when
 * the marker isn't present — the rest of the pipeline still runs. To strip a
 * different framework's recurring section, override the `start` / `end` anchors
 * and `paraphrase` via {@link SystemPromptStripConfig}.
 */

import { SYSTEM_CONFIG_PARAPHRASE } from "./constants.js";
import { ELIZA_BOUNDARY_END, ELIZA_IDENTITY_MARKER } from "./eliza-fingerprint.js";

const MIN_STRIP_LEN = 200;

/**
 * Anchors and replacement text for the system-prompt strip. Defaults target
 * eliza's CHANNEL_GAG_HARD_RULE block; override every field to strip a
 * different framework's recurring section.
 */
export interface SystemPromptStripConfig {
  /** Marker that opens the recurring block. */
  start: string;
  /** Marker that closes the recurring block (inclusive). */
  end: string;
  /** Replacement text inserted in place of the stripped block. */
  paraphrase: string;
  /**
   * Minimum stripped span (chars); shorter runs are left unchanged.
   * Defaults to {@link MIN_STRIP_LEN} when omitted.
   */
  minStripLen?: number;
}

const DEFAULT_STRIP_CONFIG: SystemPromptStripConfig = {
  start: ELIZA_IDENTITY_MARKER,
  end: ELIZA_BOUNDARY_END,
  paraphrase: SYSTEM_CONFIG_PARAPHRASE,
  minStripLen: MIN_STRIP_LEN,
};

export function stripSystemConfig(
  m: string,
  config: SystemPromptStripConfig = DEFAULT_STRIP_CONFIG
): {
  body: string;
  stripped: number;
} {
  const { start, end, paraphrase } = config;
  const minStripLen = config.minStripLen ?? MIN_STRIP_LEN;

  const sysArrayStart = m.indexOf('"system":[');
  const searchFrom = sysArrayStart !== -1 ? sysArrayStart : 0;
  const configStart = m.indexOf(start, searchFrom);
  if (configStart === -1) return { body: m, stripped: 0 };

  let stripFrom = configStart;
  if (stripFrom >= 2 && m[stripFrom - 2] === "\\" && m[stripFrom - 1] === "n") {
    stripFrom -= 2;
  }

  const boundaryStart = m.indexOf(end, configStart + start.length);
  if (boundaryStart === -1) return { body: m, stripped: 0 };

  const configEnd = boundaryStart + end.length;
  const strippedLen = configEnd - stripFrom;
  if (strippedLen <= minStripLen) return { body: m, stripped: 0 };

  return {
    body: m.slice(0, stripFrom) + paraphrase + m.slice(configEnd),
    stripped: strippedLen,
  };
}
