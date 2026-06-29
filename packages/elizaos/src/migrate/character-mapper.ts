/**
 * OpenClaw persona → Eliza `Character`.
 *
 * Maps an OcAgentSource's persona files to the Eliza Character schema using the
 * fixed file→field mapping proven in the Sol migration:
 *   SOUL.md      → system (+ bio seed)
 *   IDENTITY.md  → bio + adjectives + style.all
 *   USER.md      → knowledge (about the human) — FIREWALLED
 *   AGENTS.md    → appended behavioral notes in system
 *   playbooks    → style.chat
 *   TOOLS.md     → intentionally NOT mapped to persona (it's infra/keys)
 *
 * The mapper is conservative: it preserves the source text rather than trying to
 * "summarize" the persona (summarization loses voice). A human/agent can refine
 * the emitted character afterward.
 */

import type { MigratedCharacter as Character } from "./types.js";
import {
  isPlaybookMemory,
  isSelfMemory,
  type OcAgentSource,
} from "./openclaw-reader.js";

export interface CharacterMapOptions {
  /**
   * When true (default for portable archives), USER.md and any personal
   * knowledge is EXCLUDED from the character (firewall). The sovereign local
   * path can pass false to include it on the owner's own machine only.
   */
  firewall: boolean;
  /**
   * Optional live-context block appended to the system prompt under a
   * [CURRENT CONTEXT] marker (location/focus that overrides static bio).
   */
  currentContext?: string;
}

/** Section markers used to make the composed system prompt legible. */
const SYS_SEP = "\n\n";

/**
 * Build an Eliza Character from an OpenClaw source.
 *
 * Returns a Character with: name, system (SOUL + AGENTS behavioral + optional
 * CURRENT CONTEXT), bio (IDENTITY-derived), style.chat (playbooks), and
 * knowledge (USER, unless firewalled).
 */
export function mapToCharacter(
  src: OcAgentSource,
  opts: CharacterMapOptions,
): Character {
  const name = deriveName(src);

  // ---- system prompt: SOUL is the spine, AGENTS adds behavioral ops rules ----
  const systemParts: string[] = [];
  if (src.soul?.trim()) {
    systemParts.push(stripFrontHeading(src.soul).trim());
  } else {
    systemParts.push(`You are ${name}, an AI agent migrated onto Eliza.`);
  }
  if (src.agents?.trim()) {
    systemParts.push(
      `# Operating rules (from AGENTS.md)\n${stripFrontHeading(src.agents).trim()}`,
    );
  }
  if (opts.currentContext?.trim()) {
    systemParts.push(
      `[CURRENT CONTEXT — keep this live, it overrides static bio facts]\n${opts.currentContext.trim()}`,
    );
  }
  const system = systemParts.join(SYS_SEP);

  // ---- bio: IDENTITY drives it; fall back to SOUL's opening lines ----
  const bio = deriveBio(src, name);

  // ---- style.all + adjectives: pull from IDENTITY if present ----
  const adjectives = deriveAdjectives(src);

  // ---- style.chat: the talk playbooks (HOW to talk) ----
  const chatStyle = derivePlaybookStyle(src);

  // ---- knowledge: USER.md (about the human) — FIREWALLED ----
  const knowledge: Character["knowledge"] = [];
  if (!opts.firewall && src.user?.trim()) {
    knowledge.push({
      // DocumentSourceItem: inline text knowledge about the human.
      case: "text",
      value: { text: stripFrontHeading(src.user).trim() },
    } as unknown as NonNullable<Character["knowledge"]>[number]);
  }

  const character: Character = {
    name,
    system,
    bio,
    ...(adjectives.length ? { adjectives } : {}),
    ...(chatStyle.length ? { style: { chat: chatStyle } } : {}),
    ...(knowledge.length ? { knowledge } : {}),
    settings: {
      // Record the migration provenance + firewall posture in metadata.
      ...(opts.firewall
        ? { firewall_note: "USER/personal knowledge excluded (firewalled) from this character." }
        : {}),
    } as Character["settings"],
  };

  return character;
}

/** Derive a display name: IDENTITY "Name:" line → agentId capitalized. */
function deriveName(src: OcAgentSource): string {
  const fromIdentity = src.identity?.match(/^\s*[-*]?\s*\*{0,2}Name\*{0,2}:\s*(.+)$/im);
  if (fromIdentity?.[1]) return fromIdentity[1].replace(/\*/g, "").trim();
  return src.agentId.charAt(0).toUpperCase() + src.agentId.slice(1);
}

/**
 * Bio = IDENTITY bullet lines if present, else the first few non-heading lines
 * of SOUL. Eliza bio is string[].
 */
function deriveBio(src: OcAgentSource, name: string): string[] {
  const out: string[] = [];
  const id = src.identity;
  if (id) {
    for (const line of id.split("\n")) {
      const m = line.match(/^\s*[-*]\s+(.{12,})$/);
      if (m) out.push(m[1].trim().replace(/\s+/g, " "));
      if (out.length >= 8) break;
    }
  }
  if (out.length === 0 && src.soul) {
    for (const line of stripFrontHeading(src.soul).split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#") && !t.startsWith("*") && t.length > 20) {
        out.push(t.replace(/\s+/g, " "));
      }
      if (out.length >= 4) break;
    }
  }
  if (out.length === 0) out.push(`${name} — an AI agent migrated onto Eliza.`);
  return out;
}

/** Adjectives from an IDENTITY "Vibe:"/"adjectives" line if available. */
function deriveAdjectives(src: OcAgentSource): string[] {
  const id = src.identity;
  if (!id) return [];
  const vibe = id.match(/^\s*[-*]?\s*\*?\*?Vibe\*?\*?:\s*(.+)$/im);
  if (!vibe?.[1]) return [];
  return vibe[1]
    .split(/[,.;]/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 1 && s.length < 24 && !s.includes(" "))
    .slice(0, 10);
}

/** style.chat = the playbook memory files (conversation-playbook, channel-guide). */
function derivePlaybookStyle(src: OcAgentSource): string[] {
  const out: string[] = [];
  for (const m of src.namedMemory) {
    if (!isPlaybookMemory(m.key) || isSelfMemory(m.key)) continue;
    // Pull concise bullet/heading lines as style hints (avoid dumping whole files).
    for (const line of m.text.split("\n")) {
      const b = line.match(/^\s*[-*]\s+(.{8,140})$/);
      if (b) out.push(b[1].trim().replace(/\s+/g, " "));
      if (out.length >= 24) break;
    }
    if (out.length >= 24) break;
  }
  return out;
}

/** Drop a leading "# Title" heading line so it doesn't dominate the prompt. */
function stripFrontHeading(text: string): string {
  return text.replace(/^\s*#.*\n/, "");
}
