/**
 * GET /api/v1/voice/list — list user-cloned voices for the caller's org.
 *
 * Returns the rows the dashboard's Voice Studio binds against.
 *
 * Query parameters:
 *   - includeInactive: "true" to include soft-deleted voices (default false)
 *   - cloneType:       "instant" | "professional"
 *   - limit:           1..100 (default 50)
 *   - offset:          >=0 (default 0)
 */

import { Hono } from "hono";
import { userVoicesRepository } from "@/db/repositories/user-voices";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { parseClampedLimit, parseClampedOffset } from "@/lib/utils/clamp-limit";
import type { AppEnv } from "@/types/cloud-worker-env";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

type VoiceCloneType = "instant" | "professional";

function parseVoiceCloneType(
  raw: string | undefined,
): VoiceCloneType | undefined | null {
  if (!raw) return undefined;
  if (raw === "instant" || raw === "professional") return raw;
  return null;
}

interface VoiceListItem {
  id: string;
  elevenlabsVoiceId: string;
  name: string;
  description: string | null;
  cloneType: "instant" | "professional";
  sampleCount: number;
  totalAudioDurationSeconds: number | null;
  audioQualityScore: string | null;
  usageCount: number;
  lastUsedAt: string | null;
  isActive: boolean;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}

interface VoiceListResponse {
  success: true;
  voices: VoiceListItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    // Voice Studio inactive-row identity, not leftover tax on cloneType
    // (#21047). includeInactive=TRUE used to silently hide soft-deleted
    // voices instead of 400.
    const inactiveValues = c.req.queries("includeInactive") ?? [];
    const requestedInactive = inactiveValues[0];
    if (
      inactiveValues.length > 1 ||
      (requestedInactive != null &&
        requestedInactive !== "" &&
        requestedInactive !== "true" &&
        requestedInactive !== "false")
    ) {
      return c.json(
        {
          error: "Invalid includeInactive",
          message:
            'includeInactive must be specified at most once as "true" or "false".',
        },
        400,
      );
    }
    const includeInactive = requestedInactive === "true";
    const cloneType = parseVoiceCloneType(c.req.query("cloneType"));
    if (cloneType === null) {
      return c.json({ error: "Invalid cloneType" }, 400);
    }

    const limit = parseClampedLimit(
      c.req.query("limit"),
      DEFAULT_LIMIT,
      MAX_LIMIT,
    );
    const offset = parseClampedOffset(c.req.query("offset"));

    const result = await userVoicesRepository.listByOrganization(
      user.organization_id,
      {
        includeInactive,
        cloneType,
        limit,
        offset,
      },
    );

    const voices: VoiceListItem[] = result.voices.map((voice) => ({
      id: voice.id,
      elevenlabsVoiceId: voice.elevenlabsVoiceId,
      name: voice.name,
      description: voice.description,
      cloneType: voice.cloneType,
      sampleCount: voice.sampleCount,
      totalAudioDurationSeconds: voice.totalAudioDurationSeconds,
      audioQualityScore: voice.audioQualityScore,
      usageCount: voice.usageCount,
      lastUsedAt: voice.lastUsedAt ? voice.lastUsedAt.toISOString() : null,
      isActive: voice.isActive,
      isPublic: voice.isPublic,
      createdAt: voice.createdAt.toISOString(),
      updatedAt: voice.updatedAt.toISOString(),
    }));

    const body: VoiceListResponse = {
      success: true,
      voices,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      hasMore: result.hasMore,
    };

    return c.json(body);
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
