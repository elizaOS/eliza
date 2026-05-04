/**
 * POST /api/v1/domains/search { query, limit? }
 *
 * Keyword search for domain candidates. Returns up to N suggestions with
 * registry pricing (with eliza cloud margin applied). Useful for the agent
 * "give me a few options" flow before committing to a /buy.
 *
 * Org-scoped (not per-app) since the user picks an app to attach to AFTER
 * choosing a domain.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { cloudflareRegistrarService } from "@/lib/services/cloudflare-registrar";
import { computeDomainPrice } from "@/lib/services/domain-pricing";
import type { AppEnv } from "@/types/cloud-worker-env";

const SearchSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(100)
    .transform((s) => s.trim()),
  limit: z.number().int().min(1).max(20).optional(),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);

    const parsed = SearchSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "invalid input" },
        400,
      );
    }

    const candidates = await cloudflareRegistrarService.searchDomains(
      parsed.data.query,
      parsed.data.limit ?? 10,
    );
    return c.json({
      success: true,
      query: parsed.data.query,
      candidates: candidates.map((cand) => ({
        domain: cand.domain,
        available: cand.available,
        reason: cand.reason,
        currency: cand.currency,
        years: cand.years,
        price: cand.available ? computeDomainPrice(cand.priceUsdCents) : null,
      })),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
