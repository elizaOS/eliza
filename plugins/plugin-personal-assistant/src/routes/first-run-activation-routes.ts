/**
 * Owner-activation HTTP boundary — the idempotent server-side endpoint the app
 * onboarding flow calls when it hands the owner to the live conversation.
 *
 * `POST /api/lifeops/first-run/activate` runs the atomic
 * `OwnerActivationService` contract (one durable activation turn per
 * owner+agent+contract version, established-owner exemption, deterministic
 * memory id) and `GET /api/lifeops/first-run/activation` reads the recorded
 * entry. Both run behind the OWNER/ADMIN gate applied by `routes/plugin.ts`,
 * so this layer only re-checks that a runtime and owner identity are present.
 * A failed durable write returns 503 with `retryable: true` — the caller
 * retries; activation is never marked complete on failure.
 */

import { ElizaError, logger, type UUID } from "@elizaos/core";
import { OwnerActivationService } from "../lifeops/first-run/activation.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

const ACTIVATE_PATH = "/api/lifeops/first-run/activate";
const STATUS_PATH = "/api/lifeops/first-run/activation";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUuid(value: unknown): UUID | null {
  return typeof value === "string" && UUID_PATTERN.test(value)
    ? (value as UUID)
    : null;
}

/** Returns true when the request matched an owner-activation route. */
export async function handleOwnerActivationRoutes(
  ctx: LifeOpsRouteContext,
): Promise<boolean> {
  const { method, pathname, res, state } = ctx;
  const isActivate = pathname === ACTIVATE_PATH && method === "POST";
  const isStatus = pathname === STATUS_PATH && method === "GET";
  if (!isActivate && !isStatus) return false;

  const runtime = state.runtime;
  if (!runtime) {
    ctx.error(res, "Agent runtime is not available", 503);
    return true;
  }
  const ownerEntityId = state.adminEntityId;
  if (!ownerEntityId) {
    ctx.error(res, "Owner identity could not be resolved", 503);
    return true;
  }

  const service = new OwnerActivationService(runtime);

  if (isStatus) {
    ctx.json(res, { entry: await service.readEntry(ownerEntityId) });
    return true;
  }

  const body = await ctx.readJsonBody<Record<string, unknown>>(ctx.req, res);
  if (!body) return true;
  const roomId = parseUuid(body.roomId);
  if (!roomId) {
    ctx.error(res, "roomId must be a UUID", 400);
    return true;
  }

  try {
    const result = await service.ensureActivated({
      ownerEntityId,
      roomId,
      reactivate: body.reactivate === true,
    });
    ctx.json(res, result);
  } catch (err) {
    // error-policy:J1 boundary translation — the durable-write failure becomes
    // a retryable 503 so the onboarding caller retries observably; the service
    // guarantees activation was not marked complete.
    const code = err instanceof ElizaError ? err.code : "UNCLASSIFIED";
    logger.error(
      { src: "lifeops:owner-activation:route", code, err },
      "[OwnerActivationRoutes] Activation failed; returning retryable 503.",
    );
    ctx.json(
      res,
      { error: "Owner activation failed", code, retryable: true },
      503,
    );
  }
  return true;
}
