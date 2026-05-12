/**
 * POST /api/v1/eliza/paypal/transactions
 *
 * Searches PayPal Reporting API transactions over a date range.
 * Personal-tier accounts get a 403 with `fallback: "csv_export"` so the
 * caller can route the user to the CSV-export flow.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  AgentPaypalConnectorError,
  searchPaypalTransactions,
} from "@/lib/services/agent-paypal-connector";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const requestSchema = z.object({
  accessToken: z.string().trim().min(1),
  startDate: z.string().trim().min(10),
  endDate: z.string().trim().min(10),
  page: z.number().int().min(1).max(50).optional(),
});

app.post("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "Invalid transactions request.", details: parsed.error.issues }, 400);
    }
    const result = await searchPaypalTransactions(parsed.data);
    return c.json(result);
  } catch (error) {
    if (error instanceof AgentPaypalConnectorError) {
      return c.json(
        {
          error: error.message,
          fallback: error.status === 403 ? "csv_export" : null,
        },
        error.status as 400,
      );
    }
    return failureResponse(c, error);
  }
});

export default app;
