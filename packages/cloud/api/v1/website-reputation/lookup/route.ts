/**
 * POST /api/v1/website-reputation/lookup
 *
 * Hash-prefix website reputation lookup. The body holds only short SHA-256
 * prefixes of candidate host names (`{ prefixes: ["a1b2c3d4", ...] }`). The
 * response holds every full hash on a current threat list that starts with a
 * requested prefix, plus list freshness. The client compares full hashes
 * itself, so Cloud never receives the visited address. Prefixes are never
 * logged. A missing match is never a safety claim; see
 * `@elizaos/cloud-sdk/website-reputation` for the verdict rules.
 */

import { WEBSITE_REPUTATION_MAX_PREFIXES } from "@elizaos/cloud-sdk/website-reputation";
import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  lookupWebsiteReputationPrefixes,
  parsePrefix,
} from "@elizaos/cloud-shared/lib/services/website-reputation";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const lookupSchema = z.object({
  prefixes: z
    .array(z.string().regex(/^(?:[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/))
    .min(1)
    .max(WEBSITE_REPUTATION_MAX_PREFIXES),
});

const app = new Hono<AppEnv>();

app.post("/", rateLimit(RateLimitPresets.RELAXED), async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);
    const decoded = await decodeRequestJson(c.req);
    if (!decoded.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = lookupSchema.safeParse(decoded.value);
    if (!parsed.success) {
      return c.json({ error: "Invalid website reputation lookup" }, 400);
    }
    const prefixes = [...new Set(parsed.data.prefixes)].map(
      (prefix) => parsePrefix(prefix) as Uint8Array,
    );
    const result = await lookupWebsiteReputationPrefixes(prefixes);
    c.header("cache-control", "no-store");
    return c.json(result);
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
