/**
 * GET /.well-known/assetlinks.json — Digital Asset Links for native App Links
 * (also mounted by codegen at /api/.well-known/assetlinks.json).
 *
 * The Pages middleware proxies this exact path from eliza.app and
 * staging.eliza.app so Android's App Link verifier gets JSON from the link host
 * instead of the SPA's index.html. The document is public by construction and
 * served dynamically from admitted database registrations.
 * Always a direct 200: Android's verifier does not follow redirects.
 */

import { mobileAppAuthClientsRepository } from "@elizaos/cloud-shared/db/repositories/mobile-app-auth-clients";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

const ASSET_LINKS_CACHE_CONTROL = "public, max-age=3600";

app.get("/", async (c) => {
  const statements =
    await mobileAppAuthClientsRepository.listActiveAndroidAssetLinks(c.env);

  return c.json(statements, 200, {
    "Cache-Control": ASSET_LINKS_CACHE_CONTROL,
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
  });
});

export default app;
