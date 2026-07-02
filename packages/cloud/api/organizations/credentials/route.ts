/**
 * GET  /api/organizations/credentials — list the org's pooled credentials
 *      (MASKED: label/provider/last4/health/usage/contributor). Readable by
 *      EVERY org member — this is the low-privilege read surface members need
 *      to see pool health; no key material is ever included.
 * POST /api/organizations/credentials — contribute a provider API key to the
 *      org pool (any member). The key is live-probed against the provider
 *      BEFORE pooling and stored ciphertext-only in the secrets vault; the
 *      response is the MASKED summary — plaintext is never returned, not even
 *      here (the contributor already has the key they just pasted) (#11332).
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  contributePooledCredential,
  listPooledCredentials,
  TeamCredentialPoolError,
} from "@/lib/services/team-credential-pool/service";
import type { AppEnv } from "@/types/cloud-worker-env";

const contributeSchema = z.object({
  provider: z.string().min(1),
  apiKey: z.string().min(1),
  label: z.string().max(120).optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
});

const app = new Hono<AppEnv>();

app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const credentials = await listPooledCredentials(user.organization_id);
    return c.json({ success: true, data: credentials });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.post("/", rateLimit(RateLimitPresets.STRICT), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const body = await c.req.json();
    const validated = contributeSchema.parse(body);

    const credential = await contributePooledCredential({
      organizationId: user.organization_id,
      userId: user.id,
      provider: validated.provider,
      apiKey: validated.apiKey,
      label: validated.label,
      priority: validated.priority,
      audit: {
        actorType: "user",
        actorId: user.id,
        source: "team-credential-pool-api",
        endpoint: "POST /api/organizations/credentials",
        requestId: c.get("requestId"),
      },
    });

    return c.json(
      {
        success: true,
        data: credential,
        message: "Credential validated and added to the team pool",
      },
      201,
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json(
        { success: false, error: "Validation error", details: error.issues },
        400,
      );
    }
    if (error instanceof TeamCredentialPoolError) {
      return c.json({ success: false, error: error.message }, error.status);
    }
    return failureResponse(c, error);
  }
});

export default app;
