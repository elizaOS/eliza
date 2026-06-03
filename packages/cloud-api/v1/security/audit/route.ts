/**
 * POST /api/v1/security/audit
 *
 * Client-originated security audit event ingestion. The browser can request
 * an audit emission for user-visible security decisions, but the server owns
 * actor, org, ip, user-agent, request id, and final allowlist validation.
 */

import { AUDIT_ACTIONS, type AuditResult } from "@elizaos/security/audit";
import { Hono } from "hono";
import { z } from "zod";
import { getAuditDispatcher } from "@/api-app/services/audit-dispatcher-singleton";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserWithOrg } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const clientAuditSchema = z.object({
  action: z.enum(AUDIT_ACTIONS),
  result: z.enum(["allow", "deny", "error"]),
  resource: z
    .object({
      type: z.string().min(1).max(128),
      id: z.string().min(1).max(256),
    })
    .nullable()
    .optional(),
  metadata: z
    .record(
      z.string().min(1).max(128),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .optional(),
});

function toAuditResult(
  result: z.infer<typeof clientAuditSchema>["result"],
): AuditResult {
  switch (result) {
    case "allow":
      return "success";
    case "deny":
      return "denied";
    case "error":
      return "failure";
  }
}

function clientIp(c: AppContext): string | undefined {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    undefined
  );
}

app.post("/", async (c) => {
  try {
    const user = await requireUserWithOrg(c);
    const input = clientAuditSchema.parse(await c.req.json());
    const event = await getAuditDispatcher().emit({
      actor: { type: "user", id: user.id },
      action: input.action,
      result: toAuditResult(input.result),
      resource: input.resource ?? null,
      ip: clientIp(c),
      user_agent: c.req.header("user-agent") ?? undefined,
      request_id: c.get("requestId"),
      org_id: user.organization_id,
      metadata: input.metadata,
    });

    return c.json({ ok: true, event_id: event.event_id }, 202);
  } catch (error) {
    logger.warn("[SecurityAudit] client audit emit failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
