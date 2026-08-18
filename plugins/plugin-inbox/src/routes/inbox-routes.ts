/**
 * HTTP routes for the inbox triage surface, registered under
 * `/api/lifeops/inbox`. Serves the triage-queue read (`GET .../triage`), the
 * classify/persist write (`POST .../triage` through `InboxService.triage`), and
 * the per-entry reply / snooze / archive / approve operations (dispatched via
 * `executeInboxQueueOperation`). Owner-gated; validates and coerces request
 * bodies before handing pre-validated input to the service.
 */
import type {
  IAgentRuntime,
  Route,
  RouteHandlerContext,
  RouteHandlerResult,
} from "@elizaos/core";
import {
  executeInboxQueueOperation,
  type InboxQueueOperationResult,
} from "../actions/inbox.ts";
import { InboxService } from "../inbox/service.ts";
import type { InboundMessage, TriageClassification } from "../inbox/types.ts";

type InboxRouteOperation = "reply" | "snooze" | "archive" | "approve";

const TRIAGE_CLASSIFICATIONS = new Set<TriageClassification>([
  "ignore",
  "info",
  "notify",
  "needs_reply",
  "urgent",
]);

function json(status: number, body: unknown): RouteHandlerResult {
  return { status, body };
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function queryBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function queryInt(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Coerce a request-body `exampleLimit` to a positive integer. A missing value
 * is accepted (the service applies its own default); a present-but-invalid
 * value — non-number, non-finite, or non-positive — is rejected so the route
 * returns a clean 400 rather than forwarding a malformed count into raw SQL.
 */
function parseExampleLimit(
  value: unknown,
): { ok: true; value?: number } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return { ok: false };
  }
  return { ok: true, value: Math.floor(value) };
}

function firstQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function routeParams(
  ctx: RouteHandlerContext,
  operation?: InboxRouteOperation,
): Record<string, unknown> {
  const body = bodyRecord(ctx.body);
  return {
    ...body,
    entryId: ctx.params.id ?? body.entryId ?? body.id,
    ...(operation ? { action: operation, subaction: operation } : {}),
  };
}

/**
 * Map a thrown inbox-operation error to an HTTP status. The operation throws
 * for three distinct causes that must not collapse to one code: a missing/
 * malformed parameter (the caller's bad input → 400), an addressed entry that
 * does not exist (→ 404), and any other failure (repository/dispatch error →
 * 500). Returning 400 for all three (the prior behaviour) hid genuine
 * server-side failures behind a "bad request" the client cannot act on.
 */
function classifyInboxError(error: unknown): {
  status: number;
  message: string;
} {
  const message =
    error instanceof Error ? error.message : "Inbox operation failed.";
  if (error instanceof Error && /\bwas not found\b/.test(error.message)) {
    return { status: 404, message };
  }
  if (
    error instanceof Error &&
    /\bis required\b|\bis not supported\b|\bhas no \b/.test(error.message)
  ) {
    return { status: 400, message };
  }
  return { status: 500, message };
}

async function runOperation(
  runtime: IAgentRuntime,
  operation: InboxRouteOperation,
  params: Record<string, unknown>,
): Promise<RouteHandlerResult> {
  let result: InboxQueueOperationResult;
  try {
    result = await executeInboxQueueOperation({
      runtime,
      subaction: operation,
      params,
    });
  } catch (error) {
    // error-policy:J1 boundary translation — distinguish not-found (404) and
    // genuine operation failure (500) from malformed input (400).
    const { status, message } = classifyInboxError(error);
    return json(status, { ok: false, error: message });
  }
  return json(result.success ? 200 : 409, {
    ok: result.success,
    text: result.text,
    ...result.data,
  });
}

async function handleTriageRead(
  ctx: RouteHandlerContext,
): Promise<RouteHandlerResult> {
  const service = new InboxService(ctx.runtime);
  const classification = firstQuery(ctx.query.classification);
  const limit = queryInt(firstQuery(ctx.query.limit), 50);
  const includeSnoozed = queryBool(firstQuery(ctx.query.includeSnoozed));
  const entries =
    classification &&
    TRIAGE_CLASSIFICATIONS.has(classification.trim() as TriageClassification)
      ? await service
          .getRepository()
          .getByClassification(classification.trim() as TriageClassification, {
            limit,
            includeSnoozed,
          })
      : await service.getRepository().getUnresolved({ limit, includeSnoozed });
  return json(200, { ok: true, entries });
}

async function handleTriageWrite(
  ctx: RouteHandlerContext,
): Promise<RouteHandlerResult> {
  const body = bodyRecord(ctx.body);
  const messages = body.messages;
  if (!Array.isArray(messages)) {
    return json(400, { ok: false, error: "messages array is required" });
  }
  const exampleLimit = parseExampleLimit(body.exampleLimit);
  if (!exampleLimit.ok) {
    return json(400, {
      ok: false,
      error: "exampleLimit must be a positive number",
    });
  }
  const service = new InboxService(ctx.runtime);
  const result = await service.triage(messages as InboundMessage[], {
    classifyOnly: body.classifyOnly === true,
    ...(typeof body.ownerContext === "string"
      ? { ownerContext: body.ownerContext }
      : {}),
    ...(exampleLimit.value !== undefined
      ? { exampleLimit: exampleLimit.value }
      : {}),
  });
  return json(200, { ok: true, ...result });
}

async function inboxRouteHandler(
  ctx: RouteHandlerContext,
): Promise<RouteHandlerResult> {
  if (ctx.isTrustedLocal !== true) {
    return json(403, { ok: false, error: "Inbox routes are owner-only" });
  }

  const path = ctx.path;
  if (path === "/api/lifeops/inbox/triage") {
    return ctx.method === "POST"
      ? handleTriageWrite(ctx)
      : handleTriageRead(ctx);
  }
  if (path.endsWith("/reply")) {
    return runOperation(ctx.runtime, "reply", routeParams(ctx, "reply"));
  }
  if (path.endsWith("/snooze")) {
    return runOperation(ctx.runtime, "snooze", routeParams(ctx, "snooze"));
  }
  if (path.endsWith("/archive")) {
    return runOperation(ctx.runtime, "archive", routeParams(ctx, "archive"));
  }
  if (path.endsWith("/approve")) {
    return runOperation(ctx.runtime, "approve", routeParams(ctx, "approve"));
  }
  return json(404, { ok: false, error: "Inbox route not found" });
}

const inboxRouteSpecs: Array<{ type: Route["type"]; path: string }> = [
  { type: "GET", path: "/api/lifeops/inbox/triage" },
  { type: "POST", path: "/api/lifeops/inbox/triage" },
  { type: "POST", path: "/api/lifeops/inbox/:id/reply" },
  { type: "POST", path: "/api/lifeops/inbox/:id/snooze" },
  { type: "POST", path: "/api/lifeops/inbox/:id/archive" },
  { type: "POST", path: "/api/lifeops/inbox/:id/approve" },
];

export const inboxRoutes: Route[] = inboxRouteSpecs.map((spec) => ({
  ...spec,
  rawPath: true,
  routeHandler: inboxRouteHandler,
}));
