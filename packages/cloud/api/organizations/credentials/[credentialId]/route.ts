/**
 * PATCH  /api/organizations/credentials/:credentialId — enable/disable,
 *        re-prioritize, or relabel a pooled credential (owner/admin only).
 * DELETE /api/organizations/credentials/:credentialId — remove a credential
 *        and its vault secret (owner/admin, or the contributor removing
 *        their own key). Nobody — including the owner — can read the key.
 *
 * Both handlers fetch the row first and run `assertOrgMembership`, so a
 * cross-org id probe gets an audited 403 (#11332).
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
  getPooledCredential,
  removePooledCredential,
  TeamCredentialPoolError,
  updatePooledCredential,
} from "@/lib/services/team-credential-pool/service";
import type { AppEnv } from "@/types/cloud-worker-env";
import { assertOrgMembership } from "../../../src/middleware/org-membership";

const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    label: z.string().min(1).max(120).optional(),
  })
  .refine(
    (value) =>
      value.enabled !== undefined ||
      value.priority !== undefined ||
      value.label !== undefined,
    { message: "Provide at least one of enabled, priority, label" },
  );

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.patch("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const credentialId = c.req.param("credentialId");
    if (!credentialId) {
      return c.json(
        { success: false, error: "Credential id is required" },
        400,
      );
    }
    const row = await getPooledCredential(credentialId);
    if (!row) {
      return c.json({ success: false, error: "Credential not found" }, 404);
    }
    await assertOrgMembership(user, row.organization_id, {
      resourceType: "pooled_credential",
      resourceId: credentialId,
      c,
    });
    if (user.role !== "owner" && user.role !== "admin") {
      return c.json(
        {
          success: false,
          error: "Only owners and admins can update pool credentials",
        },
        403,
      );
    }

    const validated = updateSchema.parse(await c.req.json());
    const credential = await updatePooledCredential({
      credentialId,
      organizationId: user.organization_id,
      enabled: validated.enabled,
      priority: validated.priority,
      label: validated.label,
    });
    return c.json({ success: true, data: credential });
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

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const credentialId = c.req.param("credentialId");
    if (!credentialId) {
      return c.json(
        { success: false, error: "Credential id is required" },
        400,
      );
    }
    const row = await getPooledCredential(credentialId);
    if (!row) {
      return c.json({ success: false, error: "Credential not found" }, 404);
    }
    await assertOrgMembership(user, row.organization_id, {
      resourceType: "pooled_credential",
      resourceId: credentialId,
      c,
    });
    const isPrivileged = user.role === "owner" || user.role === "admin";
    const isContributor = row.contributed_by === user.id;
    if (!isPrivileged && !isContributor) {
      return c.json(
        {
          success: false,
          error:
            "Only owners, admins, or the contributor can remove this credential",
        },
        403,
      );
    }

    await removePooledCredential({
      credentialId,
      organizationId: user.organization_id,
      audit: {
        actorType: "user",
        actorId: user.id,
        source: "team-credential-pool-api",
        endpoint: "DELETE /api/organizations/credentials/:credentialId",
        requestId: c.get("requestId"),
      },
    });
    return c.json({
      success: true,
      message: "Credential removed from the pool",
    });
  } catch (error) {
    if (error instanceof TeamCredentialPoolError) {
      return c.json({ success: false, error: error.message }, error.status);
    }
    return failureResponse(c, error);
  }
});

export default app;
