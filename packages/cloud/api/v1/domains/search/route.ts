/**
 * POST /api/v1/domains/search { query, limit? }
 *
 * Keyword search for domain candidates. Returns up to N suggestions with
 * registry pricing (with eliza cloud margin applied). Useful for the agent
 * "give me a few options" flow before committing to a /buy.
 *
 * Untrusted POST JSON is parsed before schema validation. Syntax errors return
 * a caller-facing 400; valid JSON values are validated by the route schema.
 *
 * Org-scoped (not per-app) since the user picks an app to attach to AFTER
 * choosing a domain.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { cloudflareRegistrarService } from "@elizaos/cloud-shared/lib/services/cloudflare-registrar";
import { computeDomainPrice } from "@elizaos/cloud-shared/lib/services/domain-pricing";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const SearchSchema = z.object({
  query: z.string().trim().min(1).max(100),
  limit: z.number().int().min(1).max(20).optional(),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);

    const decodedBody = await decodeRequestJson(c.req);
    if (!decodedBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }
    const body = decodedBody.value;
    const parsed = SearchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "invalid input",
        },
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
