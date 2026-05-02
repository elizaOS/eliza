/** Injects active reading session state into agent context before response generation. */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State, UUID } from "@elizaos/core";
import { logger, validateActionKeywords, validateActionRegex } from "@elizaos/core";

import type { MysticismService } from "../services/mysticism-service";
import type {
  AstrologyReadingState,
  DrawnCard,
  FeedbackEntry,
  IChingReadingState,
  ReadingPhase,
  ReadingSession,
  ReadingSystem,
  SpreadPosition,
  TarotReadingState,
} from "../types";

const PHASE_LABELS: Record<ReadingPhase, string> = {
  intake: "gathering the user's question and preferences",
  casting: "casting / drawing — the reading has been prepared but not yet interpreted",
  interpretation: "interpreting elements one by one with the user",
  synthesis: "weaving everything together into a cohesive narrative",
  closing: "wrapping up the reading and offering final reflections",
};

const SYSTEM_LABELS: Record<ReadingSystem, string> = {
  tarot: "Tarot card reading",
  iching: "I Ching reading",
  astrology: "Astrology natal chart reading",
};

export const readingContextProvider: Provider = {
  name: "READING_CONTEXT",
  description: "Provides context about the active mystical reading session",

  dynamic: true,
  relevanceKeywords: [
    "reading",
    "context",
    "readingcontextprovider",
    "plugin",
    "mysticism",
    "status",
    "state",
    "info",
    "details",
    "chat",
    "conversation",
    "agent",
    "room",
    "channel",
  ],
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<ProviderResult> => {
    const __providerKeywords = [
      "reading",
      "context",
      "readingcontextprovider",
      "plugin",
      "mysticism",
      "status",
      "state",
      "info",
      "details",
      "chat",
      "conversation",
      "agent",
      "room",
      "channel",
    ];
    const __providerRegex = new RegExp(`\\b(${__providerKeywords.join("|")})\\b`, "i");
    const __recentMessages = _state?.recentMessagesData || [];
    const __isRelevant =
      validateActionKeywords(message, __recentMessages, __providerKeywords) ||
      validateActionRegex(message, __recentMessages, __providerRegex);
    if (!__isRelevant) {
      return { text: "" };
    }

    try {
      const service = runtime.getService<MysticismService>("MYSTICISM");
      if (!service) {
        return emptyResult();
      }

      const entityId = message.entityId as UUID;
      const roomId = message.roomId as UUID;
      if (!entityId || !roomId) {
        return emptyResult();
      }

      const session = service.getSession(entityId, roomId);
      if (!session) {
        return emptyResult();
      }

      const text = buildContextText(session);
      const values = buildValues(session);

      return {
        text,
        values,
        data: {
          sessionId: session.id,
          type: session.type,
          phase: session.phase,
          hasActiveReading: "true",
        },
      };
    } catch (error) {
      logger.error("[ReadingContextProvider] Error:", String(error));
      return emptyResult();
    }
  },
};

function emptyResult(): ProviderResult {
  return {
    text: "",
    values: { readingContext: "", hasActiveReading: "false" },
    data: { hasActiveReading: "false" },
  };
}

function buildValues(session: ReadingSession): Record<string, string> {
  return {
    readingContext: `Active ${session.type} reading in ${session.phase} phase`,
    hasActiveReading: "true",
    readingType: session.type,
    readingPhase: session.phase,
    sessionId: session.id,
  };
}

function buildContextText(session: ReadingSession): string {
  const parts: string[] = [];

  parts.push(`# Active Reading: ${SYSTEM_LABELS[session.type]}`);
  parts.push("");

  parts.push(`**Phase:** ${session.phase} — ${PHASE_LABELS[session.phase]}`);
  parts.push("");

  switch (session.type) {
    case "tarot":
      if (session.tarot) {
        parts.push(buildTarotContext(session.tarot));
      }
      break;
    case "iching":
      if (session.iching) {
        parts.push(buildIChingContext(session.iching));
      }
      break;
    case "astrology":
      if (session.astrology) {
        parts.push(buildAstrologyContext(session.astrology));
      }
      break;
  }

  if (session.paymentStatus !== "none") {
    parts.push("");
    parts.push(`## Payment Status`);
    if (session.paymentStatus === "paid") {
      parts.push(`Payment received: ${session.paymentAmount} USDC (tx: ${session.paymentTxHash})`);
      parts.push("You may proceed with the full reading.");
    } else if (session.paymentStatus === "requested") {
      parts.push(`Payment requested: ${session.paymentAmount} USDC — waiting for confirmation.`);
    }
  }

  const feedback = getSessionFeedback(session);
  if (feedback.length > 0) {
    parts.push("");
    parts.push(buildFeedbackSummary(feedback));
  }

  return parts.join("\n");
}

function buildTarotContext(state: TarotReadingState): string {
  const lines: string[] = [];

  lines.push(`## Tarot Spread: ${state.spread.name}`);
  lines.push(`**Question:** ${state.question}`);
  lines.push(`**Progress:** ${state.revealedIndex} of ${state.drawnCards.length} cards revealed`);
  lines.push("");

  if (state.revealedIndex > 0) {
    lines.push("### Cards Revealed So Far");
    for (let i = 0; i < state.revealedIndex; i++) {
      const drawn: DrawnCard = state.drawnCards[i];
      const position: SpreadPosition = state.spread.positions[i];
      const orientation = drawn.reversed ? "reversed" : "upright";
      lines.push(`- **${position.name}:** ${drawn.card.name} (${orientation})`);
    }
    lines.push("");
  }

  if (state.revealedIndex < state.drawnCards.length) {
    const nextCard = state.drawnCards[state.revealedIndex];
    const nextPos = state.spread.positions[state.revealedIndex];
    const nextOrientation = nextCard.reversed ? "reversed" : "upright";

    lines.push("### Next Card to Reveal");
    lines.push(`**Position:** ${nextPos.name} — ${nextPos.description}`);
    lines.push(`**Card:** ${nextCard.card.name} (${nextOrientation})`);

    const keywords = nextCard.reversed
      ? nextCard.card.keywords_reversed
      : nextCard.card.keywords_upright;
    lines.push(`**Key themes:** ${keywords.join(", ")}`);

    const meaning = nextCard.reversed
      ? nextCard.card.meaning_reversed
      : nextCard.card.meaning_upright;
    lines.push(`**Core meaning:** ${meaning}`);

    if (nextCard.card.element) {
      lines.push(`**Element:** ${nextCard.card.element}`);
    }
  }

  return lines.join("\n");
}

function buildIChingContext(state: IChingReadingState): string {
  const lines: string[] = [];

  lines.push("## I Ching Reading");
  lines.push(`**Question:** ${state.question}`);
  lines.push(
    `**Hexagram:** ${state.hexagram.character} ${state.hexagram.name} — ${state.hexagram.englishName}`
  );

  const changingCount = state.castResult.changingLines.length;
  const revealedCount = state.revealedLines;
  if (changingCount > 0) {
    lines.push(`**Changing Lines:** ${revealedCount} of ${changingCount} revealed`);
    lines.push(
      `**Changing positions:** ${state.castResult.changingLines.map((l) => `Line ${l}`).join(", ")}`
    );
  } else {
    lines.push("**No changing lines** — the reading is stable.");
  }

  if (state.transformedHexagram) {
    lines.push(
      `**Transforms to:** ${state.transformedHexagram.character} ${state.transformedHexagram.name} — ${state.transformedHexagram.englishName}`
    );
  }

  lines.push("");
  lines.push(`**Judgment:** ${state.hexagram.judgment}`);
  lines.push(`**Image:** ${state.hexagram.image}`);
  lines.push(`**Keywords:** ${state.hexagram.keywords.join(", ")}`);

  if (changingCount > 0 && revealedCount < changingCount) {
    const sortedChanging = [...state.castResult.changingLines].sort((a, b) => a - b);
    const nextLine = sortedChanging[revealedCount];
    const lineData = state.hexagram.lines.find((l) => l.position === nextLine);

    lines.push("");
    lines.push("### Next Changing Line to Reveal");
    lines.push(`**Line ${nextLine}**`);
    if (lineData) {
      lines.push(`**Text:** ${lineData.text}`);
      lines.push(`**Meaning:** ${lineData.meaning}`);
    }
  }

  return lines.join("\n");
}

function buildAstrologyContext(state: AstrologyReadingState): string {
  const lines: string[] = [];

  lines.push("## Natal Chart Reading");
  lines.push(
    `**Birth Data:** ${state.birthData.year}-${String(state.birthData.month).padStart(2, "0")}-${state.birthData.day != null ? String(state.birthData.day).padStart(2, "0") : "??"}` +
      (state.birthData.hour != null
        ? ` at ${String(state.birthData.hour).padStart(2, "0")}:${String(state.birthData.minute ?? 0).padStart(2, "0")}`
        : " (birth time unknown)")
  );
  if (state.birthData.latitude != null && state.birthData.longitude != null) {
    lines.push(
      `**Location:** ${state.birthData.latitude.toFixed(2)}\u00B0, ${state.birthData.longitude.toFixed(2)}\u00B0`
    );
  }
  lines.push("");

  lines.push("### The Big Three");
  lines.push(`- **Sun:** ${state.chart.sun.sign} (House ${state.chart.sun.house})`);
  lines.push(`- **Moon:** ${state.chart.moon.sign} (House ${state.chart.moon.house})`);
  lines.push(`- **Ascendant:** ${state.chart.ascendant.sign}`);
  lines.push("");

  if (state.revealedPlanets.length > 0) {
    lines.push("### Placements Discussed");
    for (const planet of state.revealedPlanets) {
      const key = planet as keyof typeof state.chart;
      const pos = state.chart[key];
      if (pos && typeof pos === "object" && "sign" in pos && "house" in pos) {
        const typed = pos as { sign: string; house: number };
        lines.push(
          `- **${planet.charAt(0).toUpperCase() + planet.slice(1)}:** ${typed.sign} (House ${typed.house})`
        );
      } else if (pos && typeof pos === "object" && "sign" in pos) {
        const typed = pos as { sign: string };
        lines.push(`- **${planet.charAt(0).toUpperCase() + planet.slice(1)}:** ${typed.sign}`);
      }
    }
    lines.push("");
  }

  const allPlanets = [
    "sun",
    "moon",
    "mercury",
    "venus",
    "mars",
    "jupiter",
    "saturn",
    "uranus",
    "neptune",
    "pluto",
  ];
  const unrevealed = allPlanets.filter((p) => !state.revealedPlanets.includes(p));
  if (unrevealed.length > 0) {
    const nextPlanet = unrevealed[0];
    const nextKey = nextPlanet as keyof typeof state.chart;
    const nextPos = state.chart[nextKey];
    lines.push("### Next Placement to Reveal");
    lines.push(`**Planet:** ${nextPlanet.charAt(0).toUpperCase() + nextPlanet.slice(1)}`);
    if (nextPos && typeof nextPos === "object" && "sign" in nextPos) {
      const typed = nextPos as { sign: string };
      lines.push(`**Sign:** ${typed.sign}`);
    }
    if (nextPos && typeof nextPos === "object" && "house" in nextPos) {
      const typed = nextPos as { house: number };
      lines.push(`**House:** ${typed.house}`);
    }
    if (nextPos && typeof nextPos === "object" && "retrograde" in nextPos) {
      const typed = nextPos as { retrograde: boolean };
      if (typed.retrograde) {
        lines.push("**Retrograde:** Yes — emphasize introspection and revisitation themes");
      }
    }
  }

  if (state.chart.aspects.length > 0) {
    const challenging = state.chart.aspects.filter((a) => a.nature === "challenging");
    const harmonious = state.chart.aspects.filter((a) => a.nature === "harmonious");
    lines.push("");
    lines.push(
      `**Aspects:** ${state.chart.aspects.length} total (${harmonious.length} harmonious, ${challenging.length} challenging)`
    );
  }

  return lines.join("\n");
}

function buildFeedbackSummary(feedback: FeedbackEntry[]): string {
  if (feedback.length === 0) return "";
  const lines: string[] = ["## What the User Has Said"];
  for (const entry of feedback.slice(-5)) {
    lines.push(`- About "${entry.element}": "${entry.userText}"`);
  }
  return lines.join("\n");
}

function getSessionFeedback(session: ReadingSession): FeedbackEntry[] {
  if (session.tarot) return session.tarot.userFeedback;
  if (session.iching) return session.iching.userFeedback;
  if (session.astrology) return session.astrology.userFeedback;
  return [];
}

export default readingContextProvider;
