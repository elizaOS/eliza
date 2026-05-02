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
import type { BirthData } from "../types";

const ASTROLOGY_KEYWORDS: readonly string[] = [
  "birth chart",
  "natal chart",
  "horoscope",
  "zodiac",
  "astrology reading",
  "what sign am i",
  "my star sign",
  "rising sign",
  "ascendant",
  "sun sign",
  "moon sign",
  "planetary placement",
  "astrological",
  "read my chart",
  "chart reading",
];

interface ParsedBirthInfo {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

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

function extractBirthInfo(text: string): ParsedBirthInfo | null {
  const t = text.toLowerCase();
  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;

  // ISO: YYYY-MM-DD or YYYY/MM/DD
  const iso = t.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (iso) {
    year = Number.parseInt(iso[1], 10);
    month = Number.parseInt(iso[2], 10);
    day = Number.parseInt(iso[3], 10);
  }

  // Named month: "March 15, 1990"
  if (!year) {
    const named = t.match(/(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})/);
    if (named) {
      month = MONTH_NAMES[named[1]] ?? null;
      day = Number.parseInt(named[2], 10);
      year = Number.parseInt(named[3], 10);
    }
  }

  if (!year || !month || !day) return null;

  // Time: HH:MM with optional AM/PM
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

function extractLocation(text: string): { latitude: number; longitude: number; timezone: number } {
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

export const astrologyReadingAction: Action = {
  name: "ASTROLOGY_READING",
  similes: ["BIRTH_CHART", "NATAL_CHART", "HOROSCOPE_READING", "ZODIAC_READING"],
  description:
    "Perform an astrological natal chart reading, progressively revealing planetary placements.",

  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["astrology", "reading"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:astrology|reading)\b/i;
    const __avRegexOk = __avRegex.test(__avText);
    const __avSource = String(message?.content?.source ?? message?.source ?? "");
    const __avExpectedSource = "";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
    const __avOptions = options && typeof options === "object" ? options : {};
    const __avInputOk =
      __avText.trim().length > 0 ||
      Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
      Boolean(message?.content && typeof message.content === "object");

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (
      runtime: IAgentRuntime,
      message: Memory,
      _state: State | undefined
    ): Promise<boolean> => {
      const text = (message.content.text ?? "").toLowerCase();
      if (!ASTROLOGY_KEYWORDS.some((kw) => text.includes(kw))) return false;

      const service = runtime.getService<MysticismService>("MYSTICISM");
      if (!service) {
        logger.warn("ASTROLOGY_READING validation failed: MysticismService not found");
        return false;
      }

      const existingSession = service.getSession(message.entityId, message.roomId);
      if (existingSession) {
        logger.debug(
          { entityId: message.entityId, roomId: message.roomId, type: existingSession.type },
          "ASTROLOGY_READING skipped: active session exists"
        );
        return false;
      }

      return true;
    };
    try {
      return Boolean(await (__avLegacyValidate as any)(runtime, message, state, options));
    } catch {
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions | Record<string, JsonValue | undefined>,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const service = runtime.getService<MysticismService>("MYSTICISM");
    if (!service) {
      logger.error("ASTROLOGY_READING handler: MysticismService not available");
      return { success: false, text: "The mysticism service is not available." };
    }

    const text = message.content.text ?? "";
    const crisis = service.detectCrisis(text);
    if (crisis.detected && crisis.severity === "high") {
      if (callback) {
        await callback({
          text:
            "I sense you're carrying something very heavy right now. " +
            "The stars will always be there for you, but first — please know " +
            "that there are people who care.\n\n" +
            crisis.recommendedAction,
        });
      }
      return {
        success: true,
        text: "Crisis detected — provided support resources instead of reading.",
      };
    }

    const birthInfo = extractBirthInfo(text);
    if (!birthInfo) {
      return {
        success: true,
        text: "Need birth data to compute natal chart.",
        data: { needsBirthData: true },
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
          sunSign,
          moonSign,
          ascendant: ascSign,
          birthData: { year: birthData.year, month: birthData.month, day: birthData.day },
        },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error computing chart";
      logger.error({ error: errorMsg }, "ASTROLOGY_READING handler failed");
      return { success: false, text: errorMsg };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Can you read my birth chart? I was born March 15, 1990 at 3:30 PM" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Let me compute your natal chart! The stars have a story to tell...",
          actions: ["ASTROLOGY_READING"],
        },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "What's my horoscope? I'm a Leo" } },
      {
        name: "{{agentName}}",
        content: {
          text: "I'd love to do a full natal chart reading. Could you share your birth date, time, and location?",
          actions: ["ASTROLOGY_READING"],
        },
      },
    ],
  ],
};
