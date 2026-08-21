/**
 * Admin integration reliability dashboard API.
 *
 * GET  /api/v1/admin/integrations/reliability          — aggregated per-provider
 *   health, error, cost, latency, stale-sync, policy-deny, reauth, kill-switch,
 *   and release-evidence report plus the production runbook checklist.
 * POST /api/v1/admin/integrations/reliability/events   — ingest telemetry
 *   events (validated and secret-redacted; idempotent per event id).
 *
 * Requires super_admin. Kill switches and release evidence are operator
 * config via the `INTEGRATION_KILL_SWITCHES` / `INTEGRATION_RELEASE_EVIDENCE`
 * env bindings; malformed entries are reported in `invalidConfig`, never
 * silently dropped. Payloads carry no PII or secrets by construction.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import {
  buildIntegrationReliabilityDashboard,
  IntegrationTelemetryValidationError,
  integrationTelemetryRecorder,
  PRODUCTION_INTEGRATION_RUNBOOK,
  parseIntegrationKillSwitches,
  parseIntegrationReleaseEvidence,
} from "@/lib/integrations/reliability";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const auth = await requireAdmin(c);
    if (auth.role !== "super_admin") {
      return c.json(
        { error: "Only super_admin can access the integration dashboard" },
        403,
      );
    }
    const env = getCloudAwareEnv();
    const killSwitchConfig = parseIntegrationKillSwitches(
      env.INTEGRATION_KILL_SWITCHES,
    );
    const evidenceConfig = parseIntegrationReleaseEvidence(
      env.INTEGRATION_RELEASE_EVIDENCE,
    );
    const dashboard = buildIntegrationReliabilityDashboard({
      events: integrationTelemetryRecorder.snapshot(),
      killSwitches: killSwitchConfig.switches,
      evidence: evidenceConfig.evidence,
    });
    return c.json({
      success: true,
      data: {
        dashboard,
        runbook: PRODUCTION_INTEGRATION_RUNBOOK,
        invalidConfig: {
          killSwitches: killSwitchConfig.invalid,
          releaseEvidence: evidenceConfig.invalid,
        },
      },
    });
  } catch (error) {
    logger.error("[Integration Reliability API] Dashboard build failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

app.post("/events", async (c) => {
  try {
    const auth = await requireAdmin(c);
    if (auth.role !== "super_admin") {
      return c.json(
        { error: "Only super_admin can ingest integration telemetry" },
        403,
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      // error-policy:J3 untrusted-input sanitizing: a non-JSON body is an
      // explicit 400, never an empty-and-successful ingest.
      return c.json(
        { error: "invalid_json", message: "body must be JSON" },
        400,
      );
    }
    const inputs = Array.isArray(body) ? body : [body];
    if (inputs.length === 0 || inputs.length > 500) {
      return c.json(
        {
          error: "invalid_batch",
          message: "provide between 1 and 500 telemetry events",
        },
        400,
      );
    }
    const rejected: { index: number; code: string; message: string }[] = [];
    let recorded = 0;
    let duplicates = 0;
    inputs.forEach((input, index) => {
      try {
        const result = integrationTelemetryRecorder.record(input);
        if (result.recorded) {
          recorded += 1;
        } else {
          duplicates += 1;
        }
      } catch (error) {
        // error-policy:J3 untrusted-input sanitizing: each malformed event is
        // reported per-index in the response; valid events still ingest.
        if (error instanceof IntegrationTelemetryValidationError) {
          rejected.push({ index, code: error.code, message: error.message });
        } else {
          throw error;
        }
      }
    });
    const status = rejected.length > 0 && recorded === 0 ? 400 : 200;
    return c.json(
      { success: status === 200, recorded, duplicates, rejected },
      status,
    );
  } catch (error) {
    logger.error("[Integration Reliability API] Event ingest failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
