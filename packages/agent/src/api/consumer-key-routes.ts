/**
 * OWNER-only HTTP boundary for account-pool consumer-key administration
 * (`/api/accounts/consumer-keys*`), backing the dashboard panel for #16478.
 *
 * This is deliberately NOT the loopback broker surface: the broker's
 * `/api/internal/account-pool/v1/*` routes authenticate with the broker bearer
 * secret, which must never reach the renderer. This boundary authorizes the
 * caller with the canonical `resolveBoundaryRole` OWNER check and reaches the
 * host's consumer-key store through the agent host bridge, so the agent never
 * imports `@elizaos/app-core`.
 *
 * Plaintext keys exist only in the create/rotate response bodies (one-time
 * display); they are never logged, persisted, or echoed anywhere else. On a
 * hostless (standalone) agent the facade is absent and every route answers
 * 501 rather than pretending an empty store exists.
 */
import type { RouteRequestContext } from "@elizaos/shared";
import { getAgentHostBridge } from "../runtime/host-bridge.ts";
import { resolveBoundaryRole } from "./server-helpers-auth.ts";

const CONSUMER_KEYS_PREFIX = "/api/accounts/consumer-keys";

interface ConsumerKeyPatchBody {
  label?: unknown;
  enabled?: unknown;
  dailyTokenQuota?: unknown;
}

/**
 * Handles `/api/accounts/consumer-keys` routes. Returns false when the path is
 * not part of this surface so the accounts dispatcher continues.
 */
export async function handleConsumerKeyRoutes(
  ctx: RouteRequestContext,
): Promise<boolean> {
  const { req, res, method, pathname, json, error, readJsonBody } = ctx;
  if (
    pathname !== CONSUMER_KEYS_PREFIX &&
    !pathname.startsWith(`${CONSUMER_KEYS_PREFIX}/`)
  ) {
    return false;
  }

  if (resolveBoundaryRole(req) !== "OWNER") {
    error(res, "Consumer-key administration requires the OWNER role", 403);
    return true;
  }

  const remainder = pathname.slice(CONSUMER_KEYS_PREFIX.length);
  const segments = remainder.split("/").filter((s) => s.length > 0);

  let id: string | null = null;
  if (segments.length > 0) {
    try {
      id = decodeURIComponent(segments[0] ?? "");
    } catch {
      // error-policy:J3 untrusted-input sanitizing — malformed percent-encoding is invalid client input
      error(res, "Invalid consumer-key id encoding", 400);
      return true;
    }
    if (!id) {
      error(res, "Missing consumer-key id", 400);
      return true;
    }
  }

  // Resolve the host service only after the authenticated path is known-valid,
  // so rejected paths cannot observe host capability or invoke bridge code.
  const admin = getAgentHostBridge().getAccountPoolConsumerKeyAdmin?.() ?? null;
  if (!admin) {
    error(res, "Consumer-key administration is unavailable on this host", 501);
    return true;
  }

  if (id === null) {
    if (method === "GET") {
      json(res, { keys: admin.list() });
      return true;
    }
    if (method === "POST") {
      const body = await readJsonBody<ConsumerKeyPatchBody>(req, res);
      if (!body) return true;
      const created = admin.create(body);
      if (!created) {
        error(res, "Invalid consumer-key fields", 400);
        return true;
      }
      json(res, created, 201);
      return true;
    }
    error(res, "Method not allowed", 405);
    return true;
  }

  if (segments.length === 1 && method === "PATCH") {
    const body = await readJsonBody<ConsumerKeyPatchBody>(req, res);
    if (!body) return true;
    const updated = admin.update(id, body);
    if (updated === "invalid") {
      error(res, "Invalid consumer-key fields", 400);
      return true;
    }
    if (!updated) {
      error(res, "Consumer key not found", 404);
      return true;
    }
    json(res, { consumer: updated });
    return true;
  }

  if (segments.length === 2 && segments[1] === "rotate" && method === "POST") {
    const rotated = admin.rotate(id);
    if (!rotated) {
      error(res, "Consumer key not found", 404);
      return true;
    }
    json(res, rotated);
    return true;
  }

  error(res, "Method not allowed", 405);
  return true;
}
