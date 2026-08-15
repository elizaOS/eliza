/** Exposes a non-mutating readiness contract for the eliza-app forwarder trust boundary. */
import type { Hono } from "hono";
import {
  FORWARDER_SECRET_HEADER,
  getForwarderAuthReadiness,
} from "./internal-auth";

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json",
} as const;

function jsonResponse(body: Record<string, string>, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Reports the gate's configuration without accepting or comparing a secret.
 * A headerless 401 is reserved for an active gate on the requested project;
 * disabled and project-mismatch states are operational failures with distinct
 * non-401 responses. Requests carrying the forwarder header are rejected
 * before configuration inspection so this endpoint cannot validate guesses.
 */
export function handleForwarderAuthReadiness(
  request: Request,
  project: string,
): Response {
  if (request.headers.has(FORWARDER_SECRET_HEADER)) {
    return jsonResponse(
      { error: "forwarder-auth-probe-must-omit-secret" },
      400,
    );
  }

  const readiness = getForwarderAuthReadiness(project);
  if (readiness === "secret-disabled") {
    return jsonResponse(
      {
        error: "forwarder-auth-not-ready",
        reason: "secret-disabled",
        project,
      },
      503,
    );
  }
  if (readiness === "project-mismatch") {
    return jsonResponse(
      {
        error: "forwarder-auth-not-ready",
        reason: "project-mismatch",
        project,
      },
      409,
    );
  }

  return jsonResponse(
    { error: "unauthorized", status: "enforced", project },
    401,
  );
}

/** Registers the public read-only gate-readiness route on the service app. */
export function registerForwarderAuthReadinessRoute(app: Hono): void {
  app.get("/ready/forwarder-auth/:project", (context) =>
    handleForwarderAuthReadiness(context.req.raw, context.req.param("project")),
  );
}
