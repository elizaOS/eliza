import { aiPricingRepository } from "../../../../db/repositories/ai-pricing";
import type { PricingDimensions } from "../../../../db/schemas/ai-pricing";
import { logger } from "../../../utils/logger";
import {
  type PricingChargeUnit,
  SUPPORTED_VIDEO_MODELS,
  type SupportedVideoModelDefinition,
} from "../../ai-pricing-definitions";
import { getCachedExternalEntries } from "../cache";
import { aiEntryToPrepared } from "../dimensions";
import { fetchText, stripHtml } from "../fetch";
import { EXTERNAL_CACHE_TTL_MS, type PreparedPricingEntry } from "../types";
import { buildMusicSnapshotEntries } from "./suno";

function extractFalPricingParagraph(html: string): string {
  const match = html.match(
    /(?:For every second of video.*?<\/p>|Your request will cost.*?<\/p>|For a 5s video without audio.*?<\/p>)/is,
  );

  if (!match) {
    throw new Error("Pricing paragraph not found on fal model page");
  }

  return stripHtml(match[0]);
}

export function buildFalEntry(
  model: SupportedVideoModelDefinition,
  unit: PricingChargeUnit,
  unitPrice: number,
  dimensions: PricingDimensions = {},
  metadata?: Record<string, unknown>,
): PreparedPricingEntry {
  const fetchedAt = new Date();
  return {
    billingSource: "fal",
    provider: "fal",
    model: model.modelId,
    productFamily: "video",
    chargeType: "generation",
    unit,
    unitPrice,
    dimensions,
    sourceKind: "fal_model_page",
    sourceUrl: model.pageUrl,
    fetchedAt,
    staleAfter: new Date(fetchedAt.getTime() + EXTERNAL_CACHE_TTL_MS),
    metadata,
  };
}

export function parseFalPricingEntries(
  model: SupportedVideoModelDefinition,
  paragraph: string,
): PreparedPricingEntry[] {
  const entries: PreparedPricingEntry[] = [];

  switch (model.pricingParser) {
    case "veo": {
      const match = paragraph.match(/\$([\d.]+)\s+\(audio off\)\s+or\s+\$([\d.]+)\s+\(audio on\)/i);
      if (!match) {
        throw new Error(`Unable to parse Veo pricing paragraph: ${paragraph}`);
      }

      entries.push(buildFalEntry(model, "second", Number(match[1]), { audio: false }));
      entries.push(buildFalEntry(model, "second", Number(match[2]), { audio: true }));
      break;
    }
    case "veo31": {
      const match = paragraph.match(
        /\$([\d.]+)\s+without audio\s+or\s+\$([\d.]+)\s+with audio\s+for 720p or 1080p.*?\$([\d.]+)\s+per second without audio,\s+or\s+\$([\d.]+)\s+with/i,
      );
      if (!match) {
        throw new Error(`Unable to parse Veo 3.1 pricing paragraph: ${paragraph}`);
      }

      for (const resolution of ["720p", "1080p"]) {
        entries.push(
          buildFalEntry(model, "second", Number(match[1]), {
            resolution,
            audio: false,
          }),
        );
        entries.push(
          buildFalEntry(model, "second", Number(match[2]), {
            resolution,
            audio: true,
          }),
        );
      }
      entries.push(
        buildFalEntry(model, "second", Number(match[3]), {
          resolution: "4k",
          audio: false,
        }),
      );
      entries.push(
        buildFalEntry(model, "second", Number(match[4]), {
          resolution: "4k",
          audio: true,
        }),
      );
      break;
    }
    case "veo31lite": {
      const match = paragraph.match(
        /\$([\d.]+)\s+for 720p with audio,\s+\$([\d.]+)\s+for 720p without audio,\s+\$([\d.]+)\s+for 1080p with audio\s+or\s+\$([\d.]+)\s+for 1080p without audio/i,
      );
      if (!match) {
        throw new Error(`Unable to parse Veo 3.1 Lite pricing paragraph: ${paragraph}`);
      }

      entries.push(
        buildFalEntry(model, "second", Number(match[1]), {
          resolution: "720p",
          audio: true,
        }),
      );
      entries.push(
        buildFalEntry(model, "second", Number(match[2]), {
          resolution: "720p",
          audio: false,
        }),
      );
      entries.push(
        buildFalEntry(model, "second", Number(match[3]), {
          resolution: "1080p",
          audio: true,
        }),
      );
      entries.push(
        buildFalEntry(model, "second", Number(match[4]), {
          resolution: "1080p",
          audio: false,
        }),
      );
      break;
    }
    case "kling": {
      const match = paragraph.match(
        /\$([\d.]+)\s+\(audio off\)\s+or\s+\$([\d.]+)\s+\(audio on\)(?:,\s+if voice control is used while generating audio you will be charged\s+\$([\d.]+))?/i,
      );
      if (!match) {
        throw new Error(`Unable to parse Kling pricing paragraph: ${paragraph}`);
      }

      entries.push(
        buildFalEntry(model, "second", Number(match[1]), {
          audio: false,
          voiceControl: false,
        }),
      );
      entries.push(
        buildFalEntry(model, "second", Number(match[2]), {
          audio: true,
          voiceControl: false,
        }),
      );
      if (match[3]) {
        entries.push(
          buildFalEntry(model, "second", Number(match[3]), {
            audio: true,
            voiceControl: true,
          }),
        );
      }
      break;
    }
    case "hailuo_standard": {
      const match = paragraph.match(/\$([\d.]+)\s+per\s+6 second.*?\$([\d.]+)\s+per\s+10 second/i);
      if (!match) {
        throw new Error(`Unable to parse Hailuo standard pricing paragraph: ${paragraph}`);
      }

      entries.push(
        buildFalEntry(model, "request", Number(match[1]), {
          durationSeconds: 6,
        }),
      );
      entries.push(
        buildFalEntry(model, "request", Number(match[2]), {
          durationSeconds: 10,
        }),
      );
      break;
    }
    case "hailuo_pro": {
      const match = paragraph.match(/\$([\d.]+)\s+per video generation/i);
      if (!match) {
        throw new Error(`Unable to parse Hailuo pro pricing paragraph: ${paragraph}`);
      }

      entries.push(buildFalEntry(model, "request", Number(match[1]), {}));
      break;
    }
    case "wan": {
      const match = paragraph.match(
        /\$([\d.]+)\s+per second for 720p,\s+\$([\d.]+)\s+per second for 1080p/i,
      );
      if (!match) {
        throw new Error(`Unable to parse Wan pricing paragraph: ${paragraph}`);
      }

      entries.push(
        buildFalEntry(model, "second", Number(match[1]), {
          resolution: "720p",
        }),
      );
      entries.push(
        buildFalEntry(model, "second", Number(match[2]), {
          resolution: "1080p",
        }),
      );
      break;
    }
    case "pixverse": {
      const match = paragraph.match(
        /\$([\d.]+)\s+for 360p and 540p,\s+\$([\d.]+)\s+for 720p,\s+and\s+\$([\d.]+)\s+for 1080p\.\s+Enabling audio adds\s+\$([\d.]+)\s+for 360p\/540p\/720p,\s+and\s+\$([\d.]+)\s+for 1080p\.\s+For 8-second videos, costs are 2x the 5-second base;\s+for 10-second videos, costs are 2.2x the 5-second base/i,
      );
      if (!match) {
        throw new Error(`Unable to parse PixVerse pricing paragraph: ${paragraph}`);
      }

      const baseByResolution: Record<string, number> = {
        "360p": Number(match[1]),
        "540p": Number(match[1]),
        "720p": Number(match[2]),
        "1080p": Number(match[3]),
      };
      const audioAddByResolution: Record<string, number> = {
        "360p": Number(match[4]),
        "540p": Number(match[4]),
        "720p": Number(match[4]),
        "1080p": Number(match[5]),
      };
      const multipliers: Record<number, number> = { 5: 1, 8: 2, 10: 2.2 };

      for (const [duration, multiplier] of Object.entries(multipliers)) {
        const numericDuration = Number(duration);
        for (const [resolution, basePrice] of Object.entries(baseByResolution)) {
          if (numericDuration === 10 && resolution === "1080p") {
            continue;
          }

          const silentPrice = basePrice * multiplier;
          entries.push(
            buildFalEntry(model, "request", silentPrice, {
              durationSeconds: numericDuration,
              resolution,
              audio: false,
            }),
          );

          const audioPrice = (basePrice + audioAddByResolution[resolution]) * multiplier;
          entries.push(
            buildFalEntry(model, "request", audioPrice, {
              durationSeconds: numericDuration,
              resolution,
              audio: true,
            }),
          );
        }
      }
      break;
    }
    case "seedance": {
      const match = paragraph.match(/\$([\d.]+)\/second/);
      if (!match) {
        throw new Error(`Unable to parse Seedance pricing paragraph: ${paragraph}`);
      }

      entries.push(
        buildFalEntry(model, "second", Number(match[1]), {
          resolution: "720p",
        }),
      );
      break;
    }
  }

  return entries;
}

export async function fetchFalCatalogEntries(): Promise<PreparedPricingEntry[]> {
  return await getCachedExternalEntries("fal", async () => {
    const entryArrays = await Promise.all(
      SUPPORTED_VIDEO_MODELS.map(async (model) => {
        try {
          const html = await fetchText(model.pageUrl);
          const paragraph = extractFalPricingParagraph(html);
          return parseFalPricingEntries(model, paragraph);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn("[AI Pricing] fal parse failed, falling back to DB", {
            model: model.modelId,
            error: message,
          });

          // Fallback: return last known active DB entries for this model
          const dbEntries = await aiPricingRepository.listActiveEntries({
            billingSource: "fal",
            provider: "fal",
            model: model.modelId,
            productFamily: "video",
            chargeType: "generation",
          });

          if (dbEntries.length > 0) {
            return dbEntries.map((entry) => aiEntryToPrepared(entry));
          }

          logger.error("[AI Pricing] No DB fallback available", {
            model: model.modelId,
          });
          return [];
        }
      }),
    );

    return [...entryArrays.flat(), ...buildMusicSnapshotEntries("fal", "fal_model_page")];
  });
}
