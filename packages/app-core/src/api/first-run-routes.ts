/**
 * Preflights app-core's canonical first-run submit boundary. The host owns
 * session/CSRF role resolution and bounded JSON validation; the shared body
 * cache replays the exact accepted bytes to the canonical agent writer. The
 * host publishes only deferred-runtime bookkeeping after durable completion.
 */
import type http from "node:http";
import { hasPersistedFirstRunState } from "@elizaos/agent/api/server-helpers";
import { hasPresentedAuthCredential } from "@elizaos/agent/api/server-helpers-auth";
import { loadElizaConfig } from "@elizaos/agent/config/config";
import { logger, readRequestBodyBuffer } from "@elizaos/core";
import { normalizeDeploymentTargetConfig } from "@elizaos/shared";
import { ensureRouteMinRole } from "./auth.ts";
import {
  type CompatRuntimeState,
  getConfiguredCompatAgentName,
} from "./compat-route-shared";
import {
  isRuntimeBootDeferred,
  triggerDeferredRuntimeBoot,
} from "./deferred-runtime-boot";
import { sendJson as sendJsonResponse } from "./response";

export const MAX_FIRST_RUN_BODY_BYTES = 1_048_576;

/** Publish host-only bookkeeping after the canonical agent response commits. */
export function finalizeFirstRunRouteResponse(
  statusCode: number,
  state: CompatRuntimeState,
): void {
  if (statusCode < 200 || statusCode >= 300) return;
  try {
    const committedConfig = loadElizaConfig();
    if (!hasPersistedFirstRunState(committedConfig)) return;
    state.pendingAgentName = getConfiguredCompatAgentName();
    const target = normalizeDeploymentTargetConfig(
      committedConfig.deploymentTarget,
    )?.runtime;
    if (isRuntimeBootDeferred() && target !== "cloud" && target !== "remote") {
      void triggerDeferredRuntimeBoot("first-run onboarding committed").catch(
        (cause) => {
          // error-policy:J5 deferred boot publishes its own error status; this
          // log observes the same rejected trigger without altering the reply.
          logger.error(
            { err: cause },
            "[api] Deferred runtime boot after first-run commit failed",
          );
        },
      );
    }
  } catch (cause) {
    // error-policy:J7 the canonical response is already committed; retain the
    // success bytes and make post-commit bookkeeping observable.
    state.current?.reportError("app-core.first-run.post-commit", cause);
  }
}

export async function handleFirstRunRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  if (method !== "POST" || url.pathname !== "/api/first-run") return false;

  if (
    !(await ensureRouteMinRole(req, res, state, "OWNER", {
      allowTrustedLocalBypass: !hasPresentedAuthCredential(req),
    }))
  ) {
    return true;
  }

  try {
    if (hasPersistedFirstRunState(loadElizaConfig())) {
      sendJsonResponse(res, 409, {
        error: "First-run setup is already complete",
      });
      return true;
    }
  } catch (cause) {
    // error-policy:J1 an unreadable durable config cannot be treated as a
    // fresh installation and must not let onboarding overwrite it.
    logger.error({ err: cause }, "[api] First-run preflight failed");
    sendJsonResponse(res, 503, { error: "First-run setup is unavailable" });
    return true;
  }

  let rawBody: Buffer | null;
  try {
    rawBody = await readRequestBodyBuffer(req, {
      maxBytes: MAX_FIRST_RUN_BODY_BYTES,
      returnNullOnTooLarge: true,
    });
  } catch (cause) {
    // error-policy:J1 the compatibility transport rejects an unreadable body
    // before the canonical writer can observe or mutate onboarding state.
    logger.warn({ err: cause }, "[api] First-run request body read failed");
    sendJsonResponse(res, 400, { error: "Invalid JSON body" });
    return true;
  }
  if (rawBody === null) {
    sendJsonResponse(res, 413, { error: "Request body too large" });
    return true;
  }

  let parsed: unknown;
  try {
    const text = rawBody.toString("utf8").trim();
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    // error-policy:J3 malformed onboarding JSON is an explicit client error;
    // the original cached bytes remain available only to accepted requests.
    sendJsonResponse(res, 400, { error: "Invalid JSON body" });
    return true;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    sendJsonResponse(res, 400, { error: "Invalid JSON body" });
    return true;
  }

  return false;
}
