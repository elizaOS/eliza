/** Exposes only registration-bound Outreachr identity and managed Google operations. */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { listManagedGoogleConnectorAccounts } from "@/lib/services/agent-google-connector";
import {
  AgentGoogleConnectorError,
  googleFetch,
} from "@/lib/services/agent-google-connector/shared";
import {
  outreachrBillingInput,
  outreachrBillingOperation,
} from "@/lib/services/outreachr-billing";
import {
  OutreachrDelegationError,
  outreachrRegistration,
} from "@/lib/services/outreachr-delegation";
import { outreachrDelegationService } from "@/lib/services/outreachr-delegation-adapter";
import { validateOutreachrGoogleRequest } from "@/lib/services/outreachr-google-request";
import { requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
app.use("*", bodyLimit({ maxSize: 1_600_000 }));
const codeInput = z
  .object({ code: z.string().startsWith("eac_").max(256) })
  .strict();
const googleInput = z
  .object({
    connectionId: z.string().uuid(),
    method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
    url: z.string().max(8192),
    body: z.string().max(1_500_000).optional(),
  })
  .strict();

app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const length = Number(c.req.header("content-length") ?? 0);
  if (length > 1_600_000)
    return c.json({ success: false, error: "Request too large" }, 413);
  return await next();
});

app.onError((error, c) => {
  if (error instanceof OutreachrDelegationError)
    return c.json(
      { success: false, error: error.message, code: error.code },
      error.status,
    );
  if (error instanceof AgentGoogleConnectorError)
    return c.json(
      { success: false, error: error.message },
      error.status === 401
        ? 401
        : error.status === 403
          ? 403
          : error.status === 404
            ? 404
            : 502,
    );
  if (error instanceof z.ZodError)
    return c.json({ success: false, error: "Request validation failed" }, 400);
  // error-policy:J1 translate route failures through the existing Cloud JSON error boundary.
  logger.error("[Outreachr] Integration request failed", { error });
  return failureResponse(c, error);
});

app.post("/token", async (c) => {
  const input = codeInput.parse(await c.req.json());
  const result = await outreachrDelegationService.exchange(
    outreachrRegistration(c.env),
    c.req.header("X-Outreachr-Client") ?? "",
    input.code,
  );
  return c.json({ success: true, ...result });
});

app.post("/revoke", async (c) => {
  await outreachrDelegationService.revoke(
    outreachrRegistration(c.env),
    c.req.header("X-Outreachr-Client") ?? "",
    c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "",
  );
  return c.json({ success: true });
});

app.get("/identity", async (c) => {
  const user = await outreachrDelegationService.authorize(
    outreachrRegistration(c.env),
    c.req.header("X-Outreachr-Client") ?? "",
    c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "",
  );
  return c.json({ success: true, user });
});

app.get("/google/connections", async (c) => {
  const user = await outreachrDelegationService.authorize(
    outreachrRegistration(c.env),
    c.req.header("X-Outreachr-Client") ?? "",
    c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "",
  );
  const connections = await listManagedGoogleConnectorAccounts({
    organizationId: user.organizationId,
    userId: user.id,
    side: "owner",
  });
  return c.json({ success: true, connections });
});

app.post("/google/request", async (c) => {
  const user = await outreachrDelegationService.authorize(
    outreachrRegistration(c.env),
    c.req.header("X-Outreachr-Client") ?? "",
    c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "",
  );
  const input = googleInput.parse(await c.req.json());
  const operation = validateOutreachrGoogleRequest(input);
  const response = await googleFetch({
    organizationId: user.organizationId,
    userId: user.id,
    side: "owner",
    grantId: input.connectionId,
    url: operation.url,
    options: {
      method: operation.method,
      headers: { "Content-Type": "application/json" },
      ...(operation.body ? { body: operation.body } : {}),
    },
  });
  // Preserve Google receipts and pagination; never unwrap access tokens or retry a send here.
  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
});

app.post("/billing", async (c) => {
  const registration = outreachrRegistration(c.env);
  await outreachrDelegationService.requireClient(
    registration,
    c.req.header("X-Outreachr-Client") ?? "",
  );
  const input = outreachrBillingInput.parse(await c.req.json());
  const result = await outreachrBillingOperation(
    requireStripe(),
    registration,
    {
      solPrice: c.env.OUTREACHR_STRIPE_SOL_PRICE ?? "",
      astraPrice: c.env.OUTREACHR_STRIPE_ASTRA_PRICE ?? "",
      webhookSecret: c.env.OUTREACHR_STRIPE_WEBHOOK_SECRET ?? "",
    },
    input,
  );
  return c.json({ success: true, ...result });
});

export default app;
