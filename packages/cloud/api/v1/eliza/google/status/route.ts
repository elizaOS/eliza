import { readPersonalGoogleContextOwner } from "@elizaos/cloud-shared/db/repositories/personal-google-context-consent";
/**
 * GET /api/v1/eliza/google/status
 *
 * Returns the managed Google connector status for the caller's organization
 * on the given `side` (default `owner`).
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  AgentGoogleConnectorError,
  getManagedGoogleConnectorStatus,
} from "@elizaos/cloud-shared/lib/services/agent-google-connector";
import {
  GOOGLE_PERSONAL_CONTEXT_PURPOSE,
  selectedGoogleContextConsent,
} from "@elizaos/cloud-shared/lib/services/shared-runtime/shared-google-consent";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const rawSide = c.req.query("side") ?? null;
    const purpose = c.req.query("purpose");
    if (purpose !== undefined && purpose !== GOOGLE_PERSONAL_CONTEXT_PURPOSE) {
      return c.json({ error: "Unknown Google connection purpose." }, 400);
    }
    if (purpose === GOOGLE_PERSONAL_CONTEXT_PURPOSE) {
      c.header("Cache-Control", "no-store");
      if (
        (rawSide !== null && rawSide !== "owner") ||
        c.req.query("grantId") !== undefined
      ) {
        return c.json(
          {
            error:
              "Personal Google context uses the owner's selected consent; side and grant overrides are not allowed.",
          },
          400,
        );
      }
      // Read only current owner metadata. Never infer personal consent from
      // the newest OAuth row or use the request's stale preference snapshot.
      const owner = await readPersonalGoogleContextOwner({
        organizationId: user.organization_id,
        userId: user.id,
      });
      if (!owner) return c.json({ error: "Active account required." }, 403);
      const consent = selectedGoogleContextConsent(owner.preferences);
      if (!consent)
        return c.json({ purpose, selectedConnectionId: null, status: null });
      try {
        const status = await getManagedGoogleConnectorStatus({
          organizationId: user.organization_id,
          userId: user.id,
          side: "owner",
          grantId: consent.grantId,
        });
        return c.json({
          purpose,
          selectedConnectionId: consent.grantId,
          status,
        });
      } catch (error) {
        if (
          error instanceof AgentGoogleConnectorError &&
          error.status === 404
        ) {
          return c.json({
            purpose,
            selectedConnectionId: consent.grantId,
            status: null,
          });
        }
        throw error;
      }
    }

    const grantId = c.req.query("grantId")?.trim();
    if (rawSide !== null && rawSide !== "owner" && rawSide !== "agent") {
      return c.json({ error: "side must be owner or agent." }, 400);
    }
    const status = await getManagedGoogleConnectorStatus({
      organizationId: user.organization_id,
      userId: user.id,
      side: rawSide === "agent" ? "agent" : "owner",
      grantId: grantId && grantId.length > 0 ? grantId : undefined,
    });
    return c.json(status);
  } catch (error) {
    if (error instanceof AgentGoogleConnectorError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
