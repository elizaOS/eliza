/**
 * Shared Utility Functions for Feed Game Engine
 *
 * Consolidated utility functions used across the engine
 */

import { CONTEXT_LIMITS, truncateText } from "./context-limits";
import { pickRandom, shuffleArray } from "./randomization";

/**
 * Format actor voice context with postStyle and randomized postExample
 *
 * Used for LLM prompt generation to maintain actor voice consistency.
 * Enhanced to make personality/postStyle/postExample more prominent
 * and provide clear matching instructions.
 */
export function formatActorVoiceContext(actor: {
  name?: string;
  realName?: string;
  postStyle?: string;
  postExample?: string[];
  voice?: string;
  personality?: string;
}): string {
  if (
    !actor.postStyle &&
    !actor.postExample &&
    !actor.voice &&
    !actor.personality
  ) {
    return "";
  }

  const parts: string[] = [];
  const actorName = actor.name || "this character";
  const realName = actor.realName?.trim();

  // Header with clear instruction
  if (realName) {
    parts.push(
      `\n   === REAL PERSON (DO NOT NAME IN OUTPUT): ${realName.toUpperCase()} ===`,
    );
    parts.push(`   === PARODY CHARACTER: ${actorName.toUpperCase()} ===`);
    parts.push(
      `   OUTPUT RULE: Never mention the real name. Always use the parody name/handle.`,
    );
  } else {
    parts.push(`\n   === VOICE FOR ${actorName.toUpperCase()} ===`);
  }

  if (actor.personality) {
    parts.push(`   PERSONALITY: ${actor.personality}`);
  }

  if (actor.voice) {
    parts.push(`   VOICE TONE: ${actor.voice}`);
  }

  if (actor.postStyle) {
    parts.push(`   WRITING STYLE: ${actor.postStyle}`);
  }

  if (actor.postExample && actor.postExample.length > 0) {
    const examples = (() => {
      const all = actor.postExample ?? [];
      if (all.length <= 5) return shuffleArray(all);

      // Stratified sampling by length to maximize variance in examples
      const sorted = [...all].sort((a, b) => a.length - b.length);
      const shortest = sorted[0]!;
      const median = sorted[Math.floor(sorted.length / 2)]!;
      const longest = sorted[sorted.length - 1]!;

      const remaining = sorted
        .slice(1, -1)
        .filter((e) => e !== median && e !== shortest && e !== longest);
      const extras = shuffleArray(remaining).slice(0, 2);
      return shuffleArray([shortest, median, longest, ...extras]);
    })();

    // Analyze example patterns for guidance
    const lengths = examples.map((ex) => ex.length);
    const minLength = Math.min(...lengths);
    const maxLength = Math.max(...lengths);
    const hasLowercase = examples.some((ex) => ex === ex.toLowerCase());
    const hasAllCaps = examples.some(
      (ex) => ex === ex.toUpperCase() && ex.length > 3,
    );
    const hasMultiLine = examples.some((ex) => ex.includes("\n"));

    parts.push(`   EXAMPLE POSTS (MATCH VOICE; VARY LENGTH):`);
    examples.forEach((ex, i) => {
      parts.push(`     ${i + 1}. "${ex}"`);
    });

    // Add derived voice hints
    const hints: string[] = [];
    if (hasLowercase) hints.push("lowercase");
    if (hasAllCaps) hints.push("ALL CAPS");
    if (hasMultiLine) hints.push("multi-line");

    if (hints.length > 0) {
      parts.push(`   VOICE PATTERN: ${hints.join(", ")}`);
    }

    // Encourage entropy in length/cadence (prevents monotone outputs over long runs)
    type LengthTarget = {
      label: "VERY SHORT" | "SHORT" | "MEDIUM" | "LONG";
      guidance: string;
    };
    const maxLenAll = Math.max(...actor.postExample.map((ex) => ex.length));
    const lengthTargets: LengthTarget[] = [
      { label: "VERY SHORT", guidance: "1-3 words or a clipped fragment." },
      { label: "SHORT", guidance: "a single punchy sentence." },
    ];
    if (maxLenAll >= 90) {
      lengthTargets.push({
        label: "MEDIUM",
        guidance: "1-2 sentences with a specific detail.",
      });
    }
    if (maxLenAll >= 140) {
      lengthTargets.push({
        label: "LONG",
        guidance:
          "2-4 sentences or a mini-thread, still under the character limit.",
      });
    }

    const chosen = pickRandom(lengthTargets) ?? lengthTargets[1]!;

    parts.push(`   LENGTH RANGE (examples): ${minLength}-${maxLength} chars`);
    parts.push(`   THIS POST: Aim for ${chosen.label} (${chosen.guidance})`);
    parts.push(
      `   YOUR POST MUST: Match tone and quirks from examples above. Avoid monotone cadence over time.`,
    );
  }

  return parts.join("\n");
}

type ToneGuardrailsActor = {
  postStyle?: string;
  postExample?: string[];
  voice?: string;
};

type SlangToken = {
  /** How to show it in the prompt */
  display: string;
  /** Lowercased match token/phrase */
  needle: string;
  /** Whether to match as whole word (vs substring) */
  wholeWord: boolean;
};

const GENERIC_SLANG_TOKENS: SlangToken[] = [
  { display: "W", needle: "w", wholeWord: true },
  { display: "L", needle: "l", wholeWord: true },
  { display: "dawg", needle: "dawg", wholeWord: true },
  { display: "bro", needle: "bro", wholeWord: true },
  { display: "fam", needle: "fam", wholeWord: true },
  { display: "fr fr", needle: "fr fr", wholeWord: false },
  { display: "no cap", needle: "no cap", wholeWord: false },
  { display: "rizz", needle: "rizz", wholeWord: true },
  { display: "ratio", needle: "ratio", wholeWord: true },
];

function buildToneCorpus(actor: ToneGuardrailsActor): string {
  const parts: string[] = [];
  if (actor.voice) parts.push(actor.voice);
  if (actor.postStyle) parts.push(actor.postStyle);
  if (actor.postExample && actor.postExample.length > 0) {
    parts.push(actor.postExample.join("\n"));
  }
  return parts.join("\n").toLowerCase();
}

function corpusIncludesToken(corpusLower: string, token: SlangToken): boolean {
  if (!corpusLower) return false;
  if (!token.wholeWord) return corpusLower.includes(token.needle);
  const pattern = new RegExp(
    `\\b${token.needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "i",
  );
  return pattern.test(corpusLower);
}

/**
 * Per-actor tone guardrails to prevent generic internet slang bleed.
 *
 * Rule: slang is only allowed if it appears in the actor's own voice/style/examples.
 */
export function formatActorToneGuardrails(actor: ToneGuardrailsActor): string {
  const corpusLower = buildToneCorpus(actor);
  const forbidden = GENERIC_SLANG_TOKENS.filter(
    (t) => !corpusIncludesToken(corpusLower, t),
  )
    .map((t) => t.display)
    .slice(0, 9);

  if (forbidden.length === 0) return "";

  return `\n=== TONE GUARDRAILS (VOICE-STRICT) ===
- Avoid generic internet slang unless it's explicitly part of YOUR character voice/examples.
- For THIS character, DO NOT use: ${forbidden.join(", ")}
=====================================`;
}

type TradingGuardrailsActor = {
  name?: string;
  domain?: string[];
  personality?: string;
  voice?: string;
  postStyle?: string;
  postExample?: string[];
};

const DEGEN_DOMAIN_MARKERS = new Set<string>(["trading", "defi", "nft"]);

const DEGEN_KEYWORDS = [
  "degen",
  "wagmi",
  "ngmi",
  "100x",
  "options",
  "insider trading",
  "leverage",
  "liquidation",
  "liq ",
  "pnl",
  "upnl",
  "funding",
  "perp",
  "futures",
  "ape ",
  "aping",
  "floor",
] as const;

const TICKER_PATTERN = /\$[a-z]{2,10}\b/;

/**
 * Heuristic: is this character a "degen" speaker who should be allowed to talk
 * in tickers/prices/leverage-style language?
 *
 * We keep this conservative: crypto interest alone is NOT enough.
 */
export function isDegenSpeaker(actor: TradingGuardrailsActor): boolean {
  const domains = actor.domain ?? [];
  if (domains.some((d) => DEGEN_DOMAIN_MARKERS.has(d))) return true;

  const corpus = [
    actor.personality ?? "",
    actor.voice ?? "",
    actor.postStyle ?? "",
    ...(actor.postExample ?? []),
  ]
    .join("\n")
    .toLowerCase();

  // If they naturally talk in ticker notation in their own voice/examples, allow it.
  if (TICKER_PATTERN.test(corpus)) return true;

  return DEGEN_KEYWORDS.some((kw) => corpus.includes(kw));
}

/**
 * Guardrails to prevent non-degen characters from drifting into trading-twitter voice
 * (tickers, exact prices, liquidation talk).
 */
export function formatActorFinanceGuardrails(
  actor: TradingGuardrailsActor,
): string {
  if (isDegenSpeaker(actor)) return "";

  const who = actor.name ? ` for ${actor.name}` : "";

  return `\n=== FINANCE/TICKER GUARDRAILS${who} ===
- DO NOT talk in tickers: no $OPENAGI / $NVDAI / $XYZ or similar.
- DO NOT cite exact prices or liquidation levels (e.g. "$151.93", "liq at 151.93").
- Avoid degen trading jargon: leverage, liquidation/liq, PnL/uPnL, long/short, entry/exit, funding.
- If you reference a company or market, do it in plain English (names + narrative), not trading notation.
=====================================`;
}

/**
 * Format full character context with entropy/variety for per-character prompts
 *
 * Shuffles order of elements, varies formatting, and includes all character details
 * to ensure each character gets full context when generating individually.
 *
 * Includes:
 * - Core identity (description, personality, voice)
 * - Social dynamics (affiliations, allies, enemies)
 * - Motivations (self-interest, reliability, expertise)
 * - Posting style (examples, patterns, target length)
 * - Emotional context (current mood, luck)
 * - Profile info (bio, tier)
 */
export function formatCharacterInfoWithEntropy(actor: {
  name?: string;
  realName?: string;
  description?: string;
  profileDescription?: string; // Their bio/self-description
  domain?: string[];
  postStyle?: string;
  postExample?: string[];
  voice?: string;
  personality?: string;
  affiliations?: string[];
  tier?: string;
  persona?: {
    reliability?: number;
    expertise?: string[];
    willingToLie?: boolean;
    selfInterest?: "wealth" | "reputation" | "ideology" | "chaos";
    favorsActors?: string[];
    opposesActors?: string[];
    favorsOrgs?: string[];
    opposesOrgs?: string[];
  };
  emotionalContext?: string;
  trackRecord?: {
    totalPosts?: number;
    accuratePosts?: number;
    historicalAccuracy?: number;
  };
  relationshipContext?: string; // Rich relationship descriptions
  currentPositions?: string; // Market positions
}): string {
  const parts: string[] = [];
  const actorName = actor.name || "Unknown";
  const realName = actor.realName?.trim();

  // Always anchor with the real person/org name first (do not use in output).
  if (realName) {
    parts.push(
      `=== REAL PERSON (DO NOT NAME IN OUTPUT): ${realName.toUpperCase()} ===`,
    );
    parts.push(`=== PARODY CHARACTER: ${actorName.toUpperCase()} ===`);
    parts.push(
      `OUTPUT RULE: Never mention the real name. Always use the parody name/handle.`,
    );
  } else {
    parts.push(`=== CHARACTER: ${actorName.toUpperCase()} ===`);
  }

  // Shuffle order of sections for entropy
  const sections: Array<{ type: string; content: string }> = [];

  // Identity/Description (core character)
  if (actor.description) {
    sections.push({
      type: "description",
      content: `IDENTITY: ${actor.description}`,
    });
  }

  // Profile description (their self-description/bio)
  if (actor.profileDescription) {
    sections.push({
      type: "profileDescription",
      content: `BIO (how you describe yourself): ${actor.profileDescription}`,
    });
  }

  // Domain/Interests
  if (actor.domain && actor.domain.length > 0) {
    const shuffledDomains = shuffleArray(actor.domain);
    sections.push({
      type: "domain",
      content: `INTERESTS/DOMAIN: ${shuffledDomains.join(", ")}`,
    });
  }

  // Affiliations
  if (actor.affiliations && actor.affiliations.length > 0) {
    sections.push({
      type: "affiliations",
      content: `AFFILIATIONS: ${shuffleArray(actor.affiliations).join(", ")}`,
    });
  }

  // Tier
  if (actor.tier) {
    sections.push({
      type: "tier",
      content: `INFLUENCE TIER: ${actor.tier}`,
    });
  }

  // Personality
  if (actor.personality) {
    sections.push({
      type: "personality",
      content: `PERSONALITY: ${actor.personality}`,
    });
  }

  // Voice (critical for matching real person's style)
  if (actor.voice) {
    sections.push({
      type: "voice",
      content: `VOICE/SPEAKING STYLE: ${actor.voice}`,
    });
  }

  // Post Style
  if (actor.postStyle) {
    sections.push({
      type: "postStyle",
      content: `WRITING STYLE: ${actor.postStyle}`,
    });
  }

  // ======= CRITICAL: SOCIAL DYNAMICS (Randomized Order) =======
  // These sections are split up so they appear in different random positions

  // ALLIES - separate section for maximum visibility
  if (actor.persona?.favorsActors && actor.persona.favorsActors.length > 0) {
    const allyVerbs = shuffleArray([
      "defend",
      "support",
      "back up",
      "co-sign",
      "ride for",
      "stand with",
    ]);
    sections.push({
      type: "allies",
      content: `🟢 YOUR ALLIES (${allyVerbs[0]}, ${allyVerbs[1]}): ${shuffleArray(actor.persona.favorsActors).join(", ")}\n→ When they post, you agree. When they're attacked, you defend.`,
    });
  }

  // RIVALS - separate section for maximum visibility
  if (actor.persona?.opposesActors && actor.persona.opposesActors.length > 0) {
    const rivalVerbs = shuffleArray([
      "attack",
      "undermine",
      "subtweet",
      "ratio",
      "dunk on",
      "mock",
    ]);
    sections.push({
      type: "rivals",
      content: `🔴 YOUR RIVALS (${rivalVerbs[0]}, ${rivalVerbs[1]}): ${shuffleArray(actor.persona.opposesActors).join(", ")}\n→ You have BEEF. Look for opportunities to clown them.`,
    });
  }

  // SUPPORTED ORGS - separate section
  if (actor.persona?.favorsOrgs && actor.persona.favorsOrgs.length > 0) {
    sections.push({
      type: "favorsOrgs",
      content: `🏢 ORGS YOU SUPPORT: ${shuffleArray(actor.persona.favorsOrgs).join(", ")}\n→ Shill subtly. Their wins are your wins.`,
    });
  }

  // OPPOSED ORGS - separate section
  if (actor.persona?.opposesOrgs && actor.persona.opposesOrgs.length > 0) {
    sections.push({
      type: "opposesOrgs",
      content: `🚫 ORGS YOU OPPOSE: ${shuffleArray(actor.persona.opposesOrgs).join(", ")}\n→ Spread FUD. Their losses make you happy.`,
    });
  }

  // ======= MOTIVATION - randomized framing =======
  if (actor.persona?.selfInterest) {
    const motivationFramings: Record<string, string[]> = {
      wealth: [
        "Motivated by WEALTH 💰 - everything is about money, valuations, gains",
        'PRIMARY DRIVER: MONEY - you think in terms of "what does this mean for my bag?"',
        "WEALTH-FOCUSED: Your posts often tie back to financial implications",
      ],
      reputation: [
        "Motivated by REPUTATION 🏆 - clout, followers, being proven right matters most",
        "PRIMARY DRIVER: CLOUT - you need to be seen as smart, connected, influential",
        "EGO-DRIVEN: Being right, having hot takes, getting engagement is your oxygen",
      ],
      ideology: [
        "Motivated by IDEOLOGY ⚔️ - true believer, pushes agenda, fights enemies",
        "PRIMARY DRIVER: THE CAUSE - you are a crusader, constantly pushing your worldview",
        "IDEOLOGUE: Everything connects to your mission. Allies are soldiers, rivals are enemies.",
      ],
      chaos: [
        "Motivated by CHAOS 🔥 - stirs drama, provocative, loves to watch things burn",
        "PRIMARY DRIVER: ENTERTAINMENT - you post to get reactions, start fights, cause drama",
        "AGENT OF CHAOS: You don't take sides consistently. You take whatever position causes the most drama.",
      ],
    };
    const framings = motivationFramings[actor.persona.selfInterest];
    if (framings && framings.length > 0) {
      const randomFraming =
        framings[Math.floor(Math.random() * framings.length)];
      sections.push({
        type: "motivation",
        content: randomFraming!,
      });
    }
  }

  // ======= DECEPTION TENDENCY - split into separate section for visibility =======
  if (actor.persona?.willingToLie !== undefined) {
    if (actor.persona.willingToLie) {
      const deceptionFramings = shuffleArray([
        "🎭 DECEPTION: You LIE strategically. Say whatever benefits you, truth is optional.",
        "⚠️ WILLING TO DECEIVE: You spread FUD, exaggerate, mislead when it serves your interests.",
        "🐍 STRATEGIC LIAR: Your statements aren't always sincere. You manipulate narrative.",
      ]);
      sections.push({
        type: "deception",
        content: deceptionFramings[0]!,
      });
    } else {
      const honestyFramings = shuffleArray([
        "✓ HONEST: You tell the truth (as you see it). Your credibility matters to you.",
        "📢 STRAIGHT SHOOTER: You don't BS. Your takes are genuine, even if unpopular.",
        "💎 AUTHENTIC: You say what you mean. People trust your word.",
      ]);
      sections.push({
        type: "honesty",
        content: honestyFramings[0]!,
      });
    }
  }

  // Track record (if they have history)
  if (actor.trackRecord?.totalPosts && actor.trackRecord.totalPosts > 0) {
    const accuracy = actor.trackRecord.historicalAccuracy
      ? `${(actor.trackRecord.historicalAccuracy * 100).toFixed(0)}%`
      : "unknown";
    sections.push({
      type: "trackRecord",
      content: `TRACK RECORD: ${actor.trackRecord.totalPosts} posts, ${accuracy} accuracy`,
    });
  }

  // Relationship context (rich descriptions of relationships)
  if (actor.relationshipContext) {
    sections.push({
      type: "relationships",
      content: `YOUR RELATIONSHIPS:\n${actor.relationshipContext}`,
    });
  }

  // Current market positions (if trading)
  if (actor.currentPositions) {
    sections.push({
      type: "positions",
      content: `YOUR CURRENT POSITIONS:\n${actor.currentPositions}`,
    });
  }

  // Post Examples (always include if available)
  if (actor.postExample && actor.postExample.length > 0) {
    const shuffledExamples = shuffleArray(actor.postExample);
    const examples = shuffledExamples.slice(
      0,
      Math.min(5, shuffledExamples.length),
    );

    const lengths = examples.map((ex) => ex.length);
    const avgLength = Math.round(
      lengths.reduce((sum, len) => sum + len, 0) / lengths.length,
    );
    const minLength = Math.min(...lengths);
    const maxLength = Math.max(...lengths);
    const hasLowercase = examples.some((ex) => ex === ex.toLowerCase());
    const hasAllCaps = examples.some(
      (ex) => ex === ex.toUpperCase() && ex.length > 3,
    );

    let examplesSection = `EXAMPLE POSTS (MATCH THIS STYLE EXACTLY):\n`;
    examples.forEach((ex, i) => {
      examplesSection += `  ${i + 1}. "${ex}"\n`;
    });

    const hints: string[] = [];
    if (avgLength < 50) hints.push("ultra-short");
    else if (avgLength < 100) hints.push("short");
    if (hasLowercase) hints.push("lowercase");
    if (hasAllCaps) hints.push("ALL CAPS");

    if (hints.length > 0) {
      examplesSection += `VOICE PATTERNS: ${hints.join(", ")}\n`;
    }
    examplesSection += `LENGTH (examples): ~${avgLength} chars (range ${minLength}-${maxLength}). Vary cadence; do not get monotone.`;

    sections.push({
      type: "examples",
      content: examplesSection,
    });
  }

  // Persona (reliability, expertise)
  if (actor.persona) {
    const personaParts: string[] = [];
    if (actor.persona.reliability !== undefined) {
      personaParts.push(
        `Reliability: ${(actor.persona.reliability * 100).toFixed(0)}%`,
      );
    }
    if (actor.persona.expertise && actor.persona.expertise.length > 0) {
      personaParts.push(
        `Expert in: ${shuffleArray(actor.persona.expertise).join(", ")}`,
      );
    }
    if (personaParts.length > 0) {
      sections.push({
        type: "persona",
        content: `PERSONA: ${personaParts.join(" | ")}`,
      });
    }
  }

  // Emotional Context
  if (actor.emotionalContext) {
    sections.push({
      type: "emotional",
      content: `CURRENT MOOD/CONTEXT: ${actor.emotionalContext}`,
    });
  }

  // Shuffle sections for entropy (but keep examples near the end for emphasis)
  const nonExampleSections = sections.filter((s) => s.type !== "examples");
  const exampleSections = sections.filter((s) => s.type === "examples");
  const shuffledNonExamples = shuffleArray(nonExampleSections);

  // Build final output with varied formatting
  parts.push(
    `╔══════════════════════════════════════════════════════════════════╗`,
  );
  parts.push(`║ CHARACTER: ${actorName.toUpperCase()}`);
  parts.push(
    `╚══════════════════════════════════════════════════════════════════╝`,
  );

  // Add shuffled sections
  shuffledNonExamples.forEach((section) => {
    parts.push(section.content);
  });

  // Always put examples at the end for emphasis
  exampleSections.forEach((section) => {
    parts.push(`\n${section.content}`);
  });

  return parts.join("\n");
}

/** Phase name constants */
export type GamePhase =
  | "WILD"
  | "CONNECTION"
  | "CONVERGENCE"
  | "CLIMAX"
  | "RESOLUTION";

/** Get the current phase based on game day */
export function getPhaseForDay(day: number): GamePhase {
  if (day <= 10) return "WILD";
  if (day <= 20) return "CONNECTION";
  if (day <= 25) return "CONVERGENCE";
  if (day <= 29) return "CLIMAX";
  return "RESOLUTION";
}

/** Phase guidance content (shared between all phase context builders) */
const PHASE_GUIDANCE: Record<GamePhase, { range: string; bullets: string[] }> =
  {
    WILD: {
      range: "Days 1-10",
      bullets: [
        "Generate mysterious, disconnected events",
        "Drop vague hints and rumors",
        "Create speculation and uncertainty",
        "Events feel random and chaotic",
        "Minimal concrete information",
        "Seeds of storylines being planted",
      ],
    },
    CONNECTION: {
      range: "Days 11-20",
      bullets: [
        "Begin connecting previous events",
        "Reveal relationships between actors",
        "Provide more concrete information",
        "Story threads start emerging",
        "Patterns become visible",
        "Narratives begin to take shape",
      ],
    },
    CONVERGENCE: {
      range: "Days 21-25",
      bullets: [
        "Major storyline convergence",
        "Big revelations about questions",
        "Clear narrative threads",
        "Dramatic developments accelerating",
        "Truth starts emerging",
        "Stakes are raised significantly",
      ],
    },
    CLIMAX: {
      range: "Days 26-29",
      bullets: [
        "Maximum drama and uncertainty",
        "Conflicting final clues",
        "Rapid developments",
        "High stakes moments",
        "Resolution seems imminent",
        "Tension at peak",
      ],
    },
    RESOLUTION: {
      range: "Day 30",
      bullets: [
        "Definitive outcomes",
        "All questions resolved",
        "Epilogue content",
        "Narrative closure",
        "The story concludes with clear endings",
      ],
    },
  };

/**
 * Build phase-specific narrative context for LLM prompts
 */
export function buildPhaseContext(day: number): string {
  const phase = getPhaseForDay(day);
  const { range, bullets } = PHASE_GUIDANCE[phase];
  return `Phase: ${phase} (${range})\n${bullets.map((b) => `- ${b}`).join("\n")}`;
}

/**
 * Get phase guidance with header formatting (for rich context builders)
 */
export function getPhaseNarrativeGuidance(phase: GamePhase): string {
  const { range, bullets } = PHASE_GUIDANCE[phase];
  return `=== CURRENT PHASE: ${phase} (${range}) ===\n${bullets.join(". ")}.`;
}

/**
 * Convert question ID to number or null
 * Handles both string and number IDs
 */
export function toQuestionIdNumberOrNull(
  id: string | number | null | undefined,
): number | null {
  if (id === null || id === undefined) {
    return null;
  }
  if (typeof id === "number") {
    return id;
  }
  const parsed = parseInt(id, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Generate a random behavioral modifier to inject into prompts.
 * These modifiers add variety and emphasize different character traits each time.
 */
export function generateBehavioralModifier(): string {
  const modifiers = shuffleArray([
    "💡 THIS POST: Focus on your relationships. Who are you supporting or attacking?",
    "💡 THIS POST: Let your personality shine through. What makes YOU unique?",
    "💡 THIS POST: Channel your motivation. What drives you? Show it.",
    "💡 THIS POST: Consider your allies. Can you co-sign or defend them?",
    "💡 THIS POST: Consider your rivals. Can you subtweet or dunk on them?",
    "💡 THIS POST: Be authentic to your voice. Short? Long? ALL CAPS? lowercase?",
    "💡 THIS POST: Show your expertise. What do you know that others don't?",
    "💡 THIS POST: React emotionally. How does this make you FEEL?",
    "💡 THIS POST: Think about your bag. How does this affect your interests?",
    "💡 THIS POST: Be provocative. What's the take that gets engagement?",
    "💡 THIS POST: Connect to a broader narrative. What story is this part of?",
    "💡 THIS POST: Flex your position. What do you know from your org?",
  ]);
  return modifiers[0]!;
}

/**
 * Build full context string for character feed generation
 * Includes trending topics, current events, and ongoing narratives
 * Maximum randomization in section ordering for variety
 */
export function buildCharacterFeedContext(options: {
  characterInfo: string;
  trendingTopics?: string;
  currentEvents?: string;
  ongoingNarratives?: string;
  recentPosts?: string;
  comprehensiveContext?: string;
  behavioralModifier?: boolean; // Add random behavioral modifier
}): string {
  // Build sections with randomized order for maximum entropy
  const sections: Array<{ priority: number; content: string }> = [];

  // Character info gets random priority 1-3 (usually high but not always first!)
  sections.push({
    priority: 1 + Math.floor(Math.random() * 3),
    content: truncateText(
      options.characterInfo,
      CONTEXT_LIMITS.MAX_SECTION_LENGTH,
    ),
  });

  // Comprehensive context (personal history) - random priority 2-5
  if (options.comprehensiveContext) {
    sections.push({
      priority: 2 + Math.floor(Math.random() * 4),
      content: truncateText(
        options.comprehensiveContext,
        CONTEXT_LIMITS.MAX_SECTION_LENGTH,
      ),
    });
  }

  // These sections get fully random priorities (3-10)
  if (options.trendingTopics) {
    sections.push({
      priority: 3 + Math.floor(Math.random() * 8),
      content: truncateText(
        `\n=== TRENDING TOPICS ===\n${options.trendingTopics}`,
        CONTEXT_LIMITS.MAX_SECTION_LENGTH,
      ),
    });
  }

  if (options.currentEvents) {
    sections.push({
      priority: 3 + Math.floor(Math.random() * 8),
      content: truncateText(
        `\n=== TODAY'S EVENTS ===\n${options.currentEvents}`,
        CONTEXT_LIMITS.MAX_SECTION_LENGTH,
      ),
    });
  }

  if (options.ongoingNarratives) {
    sections.push({
      priority: 3 + Math.floor(Math.random() * 8),
      content: truncateText(
        `\n=== ONGOING NARRATIVES ===\n${options.ongoingNarratives}`,
        CONTEXT_LIMITS.MAX_SECTION_LENGTH,
      ),
    });
  }

  if (options.recentPosts) {
    sections.push({
      priority: 3 + Math.floor(Math.random() * 8),
      content: truncateText(
        `\n=== RECENT POSTS FROM OTHERS ===\n${options.recentPosts}`,
        CONTEXT_LIMITS.MAX_SECTION_LENGTH,
      ),
    });
  }

  // Add behavioral modifier (helps vary which trait is emphasized)
  if (options.behavioralModifier !== false) {
    sections.push({
      priority: 0, // Always near the top for visibility
      content: `\n${generateBehavioralModifier()}\n`,
    });
  }

  // Sort by priority (with some randomization for same-priority items)
  const sortedSections = sections.sort((a, b) => {
    if (a.priority === b.priority) {
      return Math.random() - 0.5; // Random order for same priority
    }
    return a.priority - b.priority;
  });

  const fullContext = sortedSections.map((s) => s.content).join("\n");
  return truncateText(fullContext, CONTEXT_LIMITS.MAX_TOTAL_CONTEXT_LENGTH);
}

/**
 * Derive trading strategy from personality string.
 *
 * Parses personality with word-boundary matching for robustness.
 * Handles negation patterns (e.g., "not aggressive", "non-aggressive").
 * Precedence: aggressive > conservative > balanced.
 *
 * @param personality - Personality string to parse (may be null/undefined)
 * @returns Trading strategy: 'aggressive' | 'conservative' | 'balanced'
 *
 * @example
 * ```typescript
 * deriveStrategyFromPersonality('bold, aggressive, risk-taker'); // 'aggressive'
 * deriveStrategyFromPersonality('cautious, not aggressive'); // 'balanced'
 * deriveStrategyFromPersonality('conservative investor'); // 'conservative'
 * deriveStrategyFromPersonality('friendly, outgoing'); // 'balanced'
 * deriveStrategyFromPersonality(null); // 'balanced'
 * ```
 */
export function deriveStrategyFromPersonality(
  personality: string | null | undefined,
): "aggressive" | "conservative" | "balanced" {
  if (!personality) {
    return "balanced";
  }

  const personalityLower = personality.toLowerCase();
  const tokens = personalityLower.split(/[\s,;.]+/);

  // Check for negation patterns (e.g., "not aggressive", "non-aggressive")
  const hasNotAggressive =
    /\bnot\s+aggressive\b/.test(personalityLower) ||
    /\bnon-?aggressive\b/.test(personalityLower);
  const hasNotConservative =
    /\bnot\s+conservative\b/.test(personalityLower) ||
    /\bnon-?conservative\b/.test(personalityLower);

  // Apply precedence: aggressive > conservative > balanced
  if (tokens.includes("aggressive") && !hasNotAggressive) {
    return "aggressive";
  }
  if (tokens.includes("conservative") && !hasNotConservative) {
    return "conservative";
  }

  return "balanced";
}

/**
 * Execute async tasks in parallel with rate limiting
 * Processes tasks in batches to avoid overwhelming APIs
 *
 * @param tasks - Array of async functions to execute
 * @param batchSize - Number of tasks to run in parallel (default: 5)
 * @param delayMs - Delay between batches in milliseconds (default: 100)
 * @returns Array of results (null for failed tasks)
 */
export async function rateLimitedParallel<T>(
  tasks: Array<() => Promise<T>>,
  batchSize = 5,
  delayMs = 100,
): Promise<Array<T | null>> {
  const results: Array<T | null> = [];

  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map((task) => task()));

    for (const result of batchResults) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        // Silently handle failures - caller can filter nulls
        results.push(null);
      }
    }

    // Delay between batches (except for the last batch)
    if (i + batchSize < tasks.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

/**
 * Emoji regex pattern for stripping emojis from content.
 * Covers most common emoji Unicode ranges.
 */
const EMOJI_REGEX =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/gu;

/**
 * Strip hashtags and emojis from content.
 * Used as post-processing for LLM-generated content.
 * Preserves paragraph breaks (double newlines) for article formatting.
 *
 * @param content - Raw content from LLM
 * @returns Cleaned content without hashtags or emojis
 */
export function stripHashtagsAndEmojis(content: string): string {
  let processed = content;

  // Strip hashtags (LLMs love to add them despite instructions)
  processed = processed.replace(/#\w+/g, "");

  // Strip emojis
  processed = processed.replace(EMOJI_REGEX, "");

  // Normalize paragraph breaks: 3+ newlines → 2 newlines
  processed = processed.replace(/\n{3,}/g, "\n\n");

  // Normalize horizontal whitespace (spaces/tabs) without affecting newlines
  processed = processed.replace(/[^\S\n]+/g, " ");

  // Clean up spaces around newlines
  processed = processed.replace(/ *\n */g, "\n");

  // Trim the result
  processed = processed.trim();

  return processed;
}
