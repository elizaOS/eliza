/**
 * GET /.well-known/assetlinks.json — Digital Asset Links for native App Links
 * (also mounted by codegen at /api/.well-known/assetlinks.json).
 *
 * The Pages middleware proxies this exact path from eliza.app and
 * staging.eliza.app so Android's App Link verifier gets JSON from the link host
 * instead of the SPA's index.html. The document is public by construction and
 * built only from `ELIZA_ANDROID_ASSET_LINKS_JSON`; a malformed value is
 * served as `[]` (and logged) so no partial or guessed association is ever
 * published. Always a direct 200: Android's verifier does not follow redirects.
 */

import {
  ANDROID_ASSET_LINKS_ENV,
  parseAndroidAssetLinksConfig,
} from "@elizaos/cloud-shared/lib/auth/android-asset-links";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

const ASSET_LINKS_CACHE_CONTROL = "public, max-age=3600";

app.get("/", (c) => {
  const parsed = parseAndroidAssetLinksConfig(
    c.env?.ELIZA_ANDROID_ASSET_LINKS_JSON,
  );
  if (!parsed.ok) {
    logger.error("[assetlinks] invalid configuration; serving an empty list", {
      env: ANDROID_ASSET_LINKS_ENV,
      reason: parsed.reason,
    });
  }
  return c.json(parsed.ok ? parsed.statements : [], 200, {
    "Cache-Control": ASSET_LINKS_CACHE_CONTROL,
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
  });
});

export default app;
