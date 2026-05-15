/**
 * GET /api/v1/voice-models/catalog
 *
 * Per R5-versioning §3.1.1: signed catalog of every voice sub-model
 * version this Cloud build knows about. The device-side updater reads
 * this when the user is paired with Eliza Cloud; the GitHub releases
 * and HuggingFace tree-listing sources are fall-backs.
 *
 * Response body matches `VoiceModelCatalogResponse` from
 * `@/packages/lib/services/voice-model-catalog`. The Ed25519 signature
 * is base64-encoded in the `X-Eliza-Signature` header — the runtime
 * verifies the EXACT response text against this header before parsing.
 *
 * Cache-Control mirrors `/api/v1/models`: 15 min hard, 1 h
 * stale-while-revalidate.
 *
 * Public — no auth required. The signature is the trust root.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  buildVoiceModelCatalogBody,
  fingerprintPublicKey,
  signVoiceModelCatalog,
} from "@/lib/services/voice-model-catalog";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const signingKeyB64 = c.env.ELIZA_VOICE_CATALOG_SIGNING_KEY_BASE64;
    if (typeof signingKeyB64 !== "string" || signingKeyB64.length === 0) {
      // The runtime hard-rejects an unsigned catalog. Refusing here keeps
      // us from accidentally serving an unsigned body and confusing
      // downstream clients.
      return c.json(
        {
          error: {
            type: "service_unavailable",
            message:
              "voice-model catalog is unconfigured (ELIZA_VOICE_CATALOG_SIGNING_KEY_BASE64 missing)",
          },
        },
        503,
      );
    }

    const fingerprints: string[] = [];
    const currentPubB64 = c.env.ELIZA_VOICE_CATALOG_PUBLIC_KEY_BASE64;
    if (typeof currentPubB64 === "string" && currentPubB64.length > 0) {
      fingerprints.push(fingerprintPublicKey(currentPubB64));
    }
    const nextPubB64 = c.env.ELIZA_VOICE_CATALOG_NEXT_PUBLIC_KEY_BASE64;
    if (typeof nextPubB64 === "string" && nextPubB64.length > 0) {
      fingerprints.push(fingerprintPublicKey(nextPubB64));
    }

    const body = buildVoiceModelCatalogBody({
      now: new Date(),
      publicKeyFingerprints: fingerprints,
    });
    const bodyText = JSON.stringify(body);
    const signature = await signVoiceModelCatalog({
      bodyText,
      secretKeyBase64: signingKeyB64,
    });

    c.header("Content-Type", "application/json; charset=utf-8");
    c.header("Cache-Control", "public, s-maxage=900, stale-while-revalidate=3600");
    c.header("X-Eliza-Signature", signature);
    c.header("X-Eliza-Catalog-Schema", "eliza-1-voice-models.v1");
    return c.body(bodyText);
  } catch (error) {
    logger.error("voice-model catalog generation failed:", error);
    return failureResponse(c, error);
  }
});

export default app;
