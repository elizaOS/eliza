/**
 * Eliza App - WhatsApp Authentication Endpoint
 *
 * POST /api/eliza-app/auth/whatsapp
 *
 * Retired. It linked the `whatsapp_id` from the request body to the caller's
 * session, but a WhatsApp ID is a phone-number-derived identifier the caller
 * can type for anyone: the linked id then routed that person's WhatsApp
 * messages to the caller's agent and blocked their own link. WhatsApp is
 * linked with a code the user sends from WhatsApp itself
 * (`POST /api/eliza-app/identity-link/start` with `platform: "whatsapp"`).
 */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const honoRouter = new Hono<AppEnv>();
honoRouter.get("/", () =>
  Response.json({
    status: "ok",
    service: "eliza-app-whatsapp-auth",
    timestamp: new Date().toISOString(),
  }),
);
honoRouter.post("/", () =>
  Response.json(
    {
      success: false,
      error:
        'Link WhatsApp with a code sent from WhatsApp: POST /api/eliza-app/identity-link/start with platform "whatsapp"',
      code: "WHATSAPP_LINK_REQUIRES_CODE",
    },
    { status: 410 },
  ),
);
export default honoRouter;
