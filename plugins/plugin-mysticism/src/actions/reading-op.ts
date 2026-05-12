import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  JsonValue,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";

import type { MysticismService } from "../services/mysticism-service";
import type { BirthData, FeedbackEntry } from "../types";
import { getCurrentElement } from "../utils/reading-helpers";

type ReadingType = "tarot" | "astrology" | "iching";
type ReadingSubaction = "start" | "followup" | "deepen";

interface ReadingOpParams {
  type?: unknown;
  action?: unknown;
  question?: unknown;
  context?: unknown;
}

const SPREAD_PATTERNS: ReadonlyArray<{ pattern: RegExp; spreadId: string }> = [
  { pattern: /celtic\s*cross/i, spreadId: "celtic_cross" },
  { pattern: /three\s*card/i, spreadId: "three_card" },
  { pattern: /past\s*present\s*future/i, spreadId: "three_card" },
  { pattern: /single\s*card/i, spreadId: "single_card" },
  { pattern: /one\s*card/i, spreadId: "single_card" },
  { pattern: /horseshoe/i, spreadId: "horseshoe" },
  { pattern: /relationship/i, spreadId: "relationship" },
];

const MONTH_NAMES: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

interface ParsedBirthInfo {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function detectSpread(text: string): string {
  for (const { pattern, spreadId } of SPREAD_PATTERNS) {
    if (pattern.test(text)) {
      return spreadId;
    }
  }
  return "three_card";
}

function fallbackQuestion(text: string, defaultText: string): string {
  const cleaned = text.trim();
  return cleaned.length >= 5 ? cleaned : defaultText;
}

function extractBirthInfo(text: string): ParsedBirthInfo | null {
  const t = text.toLowerCase();
  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;

  const iso = t.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (iso) {
    year = Number.parseInt(iso[1], 10);
    month = Number.parseInt(iso[2], 10);
    day = Number.parseInt(iso[3], 10);
  }

  if (!year) {
    const named = t.match(/(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})/);
    if (named) {
      month = MONTH_NAMES[named[1]] ?? null;
      day = Number.parseInt(named[2], 10);
      year = Number.parseInt(named[3], 10);
    }
  }

  if (!year || !month || !day) return null;

  let hour = 12;
  let minute = 0;
  const time = t.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (time) {
    hour = Number.parseInt(time[1], 10);
    minute = Number.parseInt(time[2], 10);
    if (time[3]?.toLowerCase() === "pm" && hour < 12) hour += 12;
    if (time[3]?.toLowerCase() === "am" && hour === 12) hour = 0;
  }

  if (
    year < 1900 ||
    year > 2030 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return { year, month, day, hour, minute };
}

function extractLocation(text: string): {
  latitude: number;
  longitude: number;
  timezone: number;
} {
  const coordMatch = text.match(/(-?\d+\.?\d*)\s*[,/]\s*(-?\d+\.?\d*)/);
  if (coordMatch) {
    const lat = Number.parseFloat(coordMatch[1]);
    const lon = Number.parseFloat(coordMatch[2]);
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      return { latitude: lat, longitude: lon, timezone: Math.round(lon / 15) };
    }
  }
  return { latitude: 40.7128, longitude: -74.006, timezone: -5 };
}

function readParam(
  options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
  key: keyof ReadingOpParams
): unknown {
  if (!options || typeof options !== "object") {
    return undefined;
  }
  const handler = options as HandlerOptions;
  const params = handler.parameters as ReadingOpParams | undefined;
  if (params && key in params && params[key] !== undefined) {
    return params[key];
  }
  return (options as Record<string, unknown>)[key];
}

function isReadingType(value: unknown): value is ReadingType {
  return value === "tarot" || value === "astrology" || value === "iching";
}

function isSubaction(value: unknown): value is ReadingSubaction {
  return value === "start" || value === "followup" || value === "deepen";
}

async function handleStart(
  service: MysticismService,
  message: Memory,
  type: ReadingType,
  text: string,
  questionParam: string | undefined,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const crisis = service.detectCrisis(text);
  if (crisis.detected && crisis.severity === "high") {
    if (callback) {
      const lead =
        type === "tarot"
          ? "I can sense you're going through something very difficult right now. Before we continue with any reading, I want you to know that there are people who care and can help."
          : type === "iching"
            ? "I sense you're carrying something very heavy right now. Before we consult the oracle, I want you to know that there are people who care and can help."
            : "I sense you're carrying something very heavy right now. The stars will always be there for you, but first — please know that there are people who care.";
      await callback({ text: `${lead}\n\n${crisis.recommendedAction}` });
    }
    return {
      success: true,
      text: "Crisis detected — provided support resources instead of reading.",
    };
  }

  const existing = service.getSession(message.entityId, message.roomId);
  if (existing) {
    return {
      success: false,
      text: `An active ${existing.type} reading already exists for this entity/room.`,
    };
  }

  const fallbackText = questionParam ?? text;

  if (type === "tarot") {
    const spreadId = detectSpread(text);
    const question = fallbackQuestion(fallbackText, "general guidance and insight");
    try {
      const session = service.startTarotReading(
        message.entityId,
        message.roomId,
        spreadId,
        question
      );
      logger.info(
        { entityId: message.entityId, roomId: message.roomId, spread: spreadId, question },
        "Tarot reading initiated"
      );
      return {
        success: true,
        text: `Started ${spreadId} tarot reading for: ${question}`,
        data: {
          sessionId: session.id,
          type: "tarot",
          spreadName: session.tarot?.spread.name,
          cardCount: session.tarot?.drawnCards.length,
          question,
        },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error starting tarot reading";
      logger.error({ error: errorMsg }, "READING_OP tarot/start failed");
      return { success: false, text: errorMsg };
    }
  }

  if (type === "iching") {
    const question = fallbackQuestion(fallbackText, "general guidance on the path forward");
    try {
      const session = service.startIChingReading(message.entityId, message.roomId, question);
      const castingSummary = service.getIChingCastingSummary(message.entityId, message.roomId);
      logger.info(
        {
          entityId: message.entityId,
          roomId: message.roomId,
          hexagram: session.iching?.hexagram.number,
          changingLines: session.iching?.castResult.changingLines.length,
          question,
        },
        "I Ching reading initiated"
      );
      return {
        success: true,
        text: `Cast hexagram ${session.iching?.hexagram.number}: ${session.iching?.hexagram.englishName}`,
        data: {
          sessionId: session.id,
          type: "iching",
          hexagramNumber: session.iching?.hexagram.number,
          hexagramName: session.iching?.hexagram.englishName,
          changingLineCount: session.iching?.castResult.changingLines.length,
          castingSummary,
          question,
        },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error casting hexagram";
      logger.error({ error: errorMsg }, "READING_OP iching/start failed");
      return { success: false, text: errorMsg };
    }
  }

  // astrology
  const birthInfo = extractBirthInfo(text);
  if (!birthInfo) {
    return {
      success: true,
      text: "Need birth data to compute natal chart.",
      data: { type: "astrology", needsBirthData: true },
    };
  }
  const location = extractLocation(text);
  const birthData: BirthData = {
    ...birthInfo,
    latitude: location.latitude,
    longitude: location.longitude,
    timezone: location.timezone,
  };
  try {
    const session = service.startAstrologyReading(message.entityId, message.roomId, birthData);
    const sunSign = session.astrology?.chart.sun.sign ?? "unknown";
    const moonSign = session.astrology?.chart.moon.sign ?? "unknown";
    const ascSign = session.astrology?.chart.ascendant.sign ?? "unknown";
    logger.info(
      { entityId: message.entityId, roomId: message.roomId, sunSign },
      "Astrology reading initiated"
    );
    return {
      success: true,
      text: `Computed natal chart: Sun in ${sunSign}, Moon in ${moonSign}`,
      data: {
        sessionId: session.id,
        type: "astrology",
        sunSign,
        moonSign,
        ascendant: ascSign,
        birthData: {
          year: birthData.year,
          month: birthData.month,
          day: birthData.day,
        },
      },
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error computing chart";
    logger.error({ error: errorMsg }, "READING_OP astrology/start failed");
    return { success: false, text: errorMsg };
  }
}

async function handleFollowup(
  service: MysticismService,
  message: Memory,
  text: string,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const crisis = service.detectCrisis(text);
  if (crisis.detected && crisis.severity === "high") {
    service.endSession(message.entityId, message.roomId);
    if (callback) {
      await callback({
        text:
          "I want to pause our reading for a moment. What you're expressing " +
          `concerns me, and I care about your wellbeing more than any reading.\n\n${crisis.recommendedAction}`,
      });
    }
    return {
      success: true,
      text: "Crisis detected during reading — session ended, resources provided.",
    };
  }

  const session = service.getSession(message.entityId, message.roomId);
  if (!session) {
    return { success: false, text: "No active reading session found." };
  }

  const currentElement = getCurrentElement(session);
  const feedback: FeedbackEntry = {
    element: currentElement,
    userText: text,
    timestamp: Date.now(),
  };
  service.recordFeedback(message.entityId, message.roomId, feedback);

  const nextReveal = service.getNextReveal(message.entityId, message.roomId);
  if (nextReveal) {
    if (callback) {
      await callback({
        text: `**${nextReveal.element}**\n\n${nextReveal.prompt}`,
      });
    }
    logger.debug(
      { entityId: message.entityId, roomId: message.roomId, element: nextReveal.element },
      "Reading followup: next reveal"
    );
    return { success: true, text: `Revealed next element: ${nextReveal.element}` };
  }

  return finalizeReading(service, message.entityId, message.roomId, callback);
}

async function handleDeepen(
  service: MysticismService,
  message: Memory,
  text: string,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const session = service.getSession(message.entityId, message.roomId);
  if (!session) {
    return { success: false, text: "No active reading session found." };
  }

  if (session.type === "tarot" && session.tarot) {
    const lastRevealedIndex = session.tarot.revealedIndex - 1;
    if (lastRevealedIndex >= 0) {
      const deepenPrompt = service.getDeepeningPrompt(
        message.entityId,
        message.roomId,
        lastRevealedIndex,
        text
      );
      if (deepenPrompt && callback) {
        const card = session.tarot.drawnCards[lastRevealedIndex];
        const cardName = card.reversed ? `${card.card.name} (Reversed)` : card.card.name;
        await callback({ text: `Let me look more deeply at the **${cardName}**...` });
        logger.debug(
          { entityId: message.entityId, cardIndex: lastRevealedIndex, card: card.card.name },
          "Deepening tarot card"
        );
        return { success: true, text: `Deepened interpretation of ${cardName}` };
      }
    }
  }

  if (callback) {
    const nextReveal = service.getNextReveal(message.entityId, message.roomId);
    if (nextReveal) {
      await callback({
        text:
          "Let me explore that further and connect it to the next element " +
          `of your reading...\n\n**${nextReveal.element}**\n\n${nextReveal.prompt}`,
      });
      return {
        success: true,
        text: `Deepened via next reveal: ${nextReveal.element}`,
      };
    }
    await callback({
      text:
        "We've explored all the elements of your reading. " +
        "Let me weave everything together into a final synthesis...",
    });
    return finalizeReading(service, message.entityId, message.roomId, callback);
  }

  return { success: true, text: "Deepening handled." };
}

async function finalizeReading(
  service: MysticismService,
  entityId: string,
  roomId: string,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const synthesis = service.getSynthesis(entityId, roomId);
  if (synthesis && callback) {
    await callback({
      text: "Now let me bring all the threads of your reading together...",
    });
  }
  service.endSession(entityId, roomId);
  logger.info({ entityId, roomId }, "Reading synthesis completed");
  return {
    success: true,
    text: "Reading complete — synthesis delivered and session ended.",
  };
}

export const readingOpAction: Action = {
  name: "MYSTICISM_READING",
  contexts: ["knowledge", "general"],
  contextGate: { anyOf: ["knowledge", "general"] },
  roleGate: { minRole: "USER" },
  similes: [
    "READING",
    "TAROT_READING",
    "READ_TAROT",
    "DRAW_CARDS",
    "TAROT_SPREAD",
    "CARD_READING",
    "ICHING_READING",
    "CAST_HEXAGRAM",
    "CONSULT_ICHING",
    "THROW_COINS",
    "ORACLE_READING",
    "ASTROLOGY_READING",
    "BIRTH_CHART",
    "NATAL_CHART",
    "HOROSCOPE_READING",
    "ZODIAC_READING",
    "READING_FOLLOWUP",
    "CONTINUE_READING",
    "NEXT_CARD",
    "PROCEED_READING",
    "DEEPEN_READING",
    "EXPLORE_DEEPER",
    "ELABORATE_READING",
  ],
  description:
    "Mystical reading router. Set type to tarot, astrology, or iching, and action to start (begin a new reading), followup (reveal the next element), or deepen (more interpretation for the most-recent element).",
  descriptionCompressed:
    "Mystical readings: tarot, astrology, iching; actions: start, followup, deepen.",

  parameters: [
    {
      name: "type",
      description: "Reading type: tarot, astrology, or iching.",
      required: true,
      schema: { type: "string" as const, enum: ["tarot", "astrology", "iching"] },
    },
    {
      name: "action",
      description: "Action: start, followup, or deepen.",
      required: true,
      schema: {
        type: "string" as const,
        enum: ["start", "followup", "deepen"],
      },
    },
    {
      name: "question",
      description: "Optional question or focus for the reading.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "context",
      description: "Optional additional context (e.g., birth data hint for astrology).",
      required: false,
      schema: { type: "string" as const },
    },
  ],

  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    return runtime.getService<MysticismService>("MYSTICISM") !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions | Record<string, JsonValue | undefined>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<MysticismService>("MYSTICISM");
    if (!service) {
      logger.error("READING_OP handler: MysticismService not available");
      return {
        success: false,
        text: "The mysticism service is not available.",
      };
    }

    const typeRaw = readParam(options, "type");
    const subRaw = readParam(options, "action");
    if (!isReadingType(typeRaw)) {
      return {
        success: false,
        text: `READING_OP requires type in {tarot, astrology, iching}, got ${String(typeRaw)}`,
      };
    }
    if (!isSubaction(subRaw)) {
      return {
        success: false,
        text: `READING_OP requires action in {start, followup, deepen}, got ${String(subRaw)}`,
      };
    }

    const text = (message.content.text ?? "").slice(0, 2_000);
    const questionRaw = readParam(options, "question");
    const question = typeof questionRaw === "string" ? questionRaw.slice(0, 2_000) : undefined;

    if (subRaw === "start") {
      return handleStart(service, message, typeRaw, text, question, callback);
    }
    if (subRaw === "followup") {
      return handleFollowup(service, message, text, callback);
    }
    return handleDeepen(service, message, text, callback);
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Can you do a tarot reading for me?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'd be happy to do a tarot reading. Let me shuffle the cards...",
          actions: ["MYSTICISM_READING"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "I'd like to consult the I Ching" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Let us consult the ancient oracle. I'll cast the coins for your hexagram...",
          actions: ["MYSTICISM_READING"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Can you read my birth chart?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'd love to explore your natal chart. First, I'll need your birth details...",
          actions: ["MYSTICISM_READING"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "That resonates. What's next?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Let me reveal the next element of your reading...",
          actions: ["MYSTICISM_READING"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Tell me more about that card" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Let me look more deeply at that element of your reading...",
          actions: ["MYSTICISM_READING"],
        },
      },
    ],
  ],
};
