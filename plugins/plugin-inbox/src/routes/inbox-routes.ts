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
    return json(400, {
      ok: false,
      error: error instanceof Error ? error.message : "Inbox operation failed.",
    });
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
  const service = new InboxService(ctx.runtime);
  const result = await service.triage(messages as InboundMessage[], {
    classifyOnly: body.classifyOnly === true,
    ...(typeof body.ownerContext === "string"
      ? { ownerContext: body.ownerContext }
      : {}),
    ...(typeof body.exampleLimit === "number"
      ? { exampleLimit: body.exampleLimit }
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
