/**
 * Owner-only HTTP contracts for school-calendar workflow control and monthly
 * family packet generation, review, drafting, and canonical approval enqueue.
 */

import type { FamilyPacketPeriod } from "../lifeops/family-coordination/index.js";
import { getFamilyWorkflowRuntimeService } from "../lifeops/family-workflows/index.js";
import { CONCORD_SCHOOL_CALENDAR_SOURCE } from "../lifeops/school/calendar-workflow.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

function service(ctx: LifeOpsRouteContext) {
  const runtime = ctx.state.runtime;
  if (!runtime) {
    ctx.error(ctx.res, "Agent runtime is not available", 503);
    return null;
  }
  const value = getFamilyWorkflowRuntimeService(runtime);
  if (!value) {
    ctx.error(ctx.res, "Family workflow runtime is not available", 503);
    return null;
  }
  return value;
}

export async function handleFamilyWorkflowRoutes(
  ctx: LifeOpsRouteContext,
): Promise<boolean> {
  const { method, pathname, req, res, json, readJsonBody, url } = ctx;
  if (!pathname.startsWith("/api/lifeops/family-workflows")) return false;
  const runtimeService = service(ctx);
  if (!runtimeService) return true;
  try {
    if (
      method === "PUT" &&
      pathname === "/api/lifeops/family-workflows/school/source"
    ) {
      json(
        res,
        await runtimeService.configureSchool(CONCORD_SCHOOL_CALENDAR_SOURCE),
      );
      return true;
    }
    if (
      method === "GET" &&
      pathname === "/api/lifeops/family-workflows/school/status"
    ) {
      json(res, await runtimeService.schoolStatus());
      return true;
    }
    if (
      method === "POST" &&
      pathname === "/api/lifeops/family-workflows/school/run"
    ) {
      json(res, await runtimeService.runSchool("manual"));
      return true;
    }
    const schoolReviewMatch = pathname.match(
      /^\/api\/lifeops\/family-workflows\/school\/runs\/([^/]+)$/u,
    );
    if (method === "GET" && schoolReviewMatch) {
      const review = await runtimeService.reviewSchool(
        decodeURIComponent(schoolReviewMatch[1] ?? ""),
      );
      if (!review) ctx.error(res, "School calendar run not found", 404);
      else json(res, review);
      return true;
    }
    if (
      method === "POST" &&
      pathname === "/api/lifeops/family-workflows/school/apply"
    ) {
      const body = await readJsonBody<{ runId?: unknown }>(req, res);
      if (!body) return true;
      if (typeof body.runId !== "string" || !body.runId.trim()) {
        ctx.error(res, "runId is required", 400);
        return true;
      }
      await runtimeService.applySchool(body.runId.trim(), url);
      json(res, { applied: true, runId: body.runId.trim() });
      return true;
    }
    if (
      method === "POST" &&
      pathname === "/api/lifeops/family-workflows/run-now"
    ) {
      json(res, await runtimeService.runMonthly("manual"));
      return true;
    }
    if (
      method === "GET" &&
      pathname === "/api/lifeops/family-workflows/packets"
    ) {
      const packets = await runtimeService.packets.list(
        url.searchParams.get("period") ?? undefined,
      );
      json(res, {
        packets,
        packetStates: await Promise.all(
          packets.map(async (packet) => {
            const draft = await runtimeService.packets.readLatestDraft(
              packet.packetId,
            );
            return {
              packetId: packet.packetId,
              draft,
              approvalId: draft
                ? await runtimeService.packets.readDraftApprovalId(
                    packet.packetId,
                    draft.draftVersion,
                  )
                : null,
            };
          }),
        ),
      });
      return true;
    }
    if (
      method === "POST" &&
      pathname === "/api/lifeops/family-workflows/packets"
    ) {
      const body = await readJsonBody<{ period?: FamilyPacketPeriod }>(
        req,
        res,
      );
      if (body === null) return true;
      json(res, await runtimeService.generatePacket(body.period));
      return true;
    }
    const packetMatch = pathname.match(
      /^\/api\/lifeops\/family-workflows\/packets\/([^/]+)$/u,
    );
    if (method === "GET" && packetMatch) {
      const packet = await runtimeService.packets.read(
        decodeURIComponent(packetMatch[1] ?? ""),
      );
      if (!packet) ctx.error(res, "Packet not found", 404);
      else json(res, packet);
      return true;
    }
    const draftMatch = pathname.match(
      /^\/api\/lifeops\/family-workflows\/packets\/([^/]+)\/drafts$/u,
    );
    if (method === "POST" && draftMatch) {
      const body = await readJsonBody<{
        recipient?: unknown;
        recipientEntityId?: unknown;
        calendarPrivacyMode?: unknown;
      }>(req, res);
      if (!body) return true;
      if (typeof body.recipient !== "string" || !body.recipient.trim()) {
        ctx.error(res, "recipient is required", 400);
        return true;
      }
      if (
        typeof body.recipientEntityId !== "string" ||
        !body.recipientEntityId.trim() ||
        !["full", "times_only", "busy_only"].includes(
          String(body.calendarPrivacyMode),
        )
      ) {
        ctx.error(
          res,
          "recipientEntityId and calendarPrivacyMode are required",
          400,
        );
        return true;
      }
      json(
        res,
        await runtimeService.createDraft(
          decodeURIComponent(draftMatch[1] ?? ""),
          {
            recipient: body.recipient.trim(),
            recipientEntityId: body.recipientEntityId.trim(),
            calendarPrivacyMode: body.calendarPrivacyMode as
              | "full"
              | "times_only"
              | "busy_only",
          },
        ),
        201,
      );
      return true;
    }
    const approvalMatch = pathname.match(
      /^\/api\/lifeops\/family-workflows\/packets\/([^/]+)\/drafts\/(\d+)\/approval$/u,
    );
    if (method === "POST" && approvalMatch) {
      const body = await readJsonBody<{ expiresAt?: unknown }>(req, res);
      if (!body) return true;
      const expiresAt =
        typeof body.expiresAt === "string"
          ? new Date(body.expiresAt)
          : new Date(Date.now() + 7 * 24 * 60 * 60_000);
      if (!Number.isFinite(expiresAt.getTime())) {
        ctx.error(res, "expiresAt must be an ISO date", 400);
        return true;
      }
      const actor = String(ctx.state.adminEntityId ?? "self");
      json(
        res,
        await runtimeService.requestDraftApproval({
          packetId: decodeURIComponent(approvalMatch[1] ?? ""),
          draftVersion: Number(approvalMatch[2]),
          requestedBy: actor,
          subjectUserId: actor,
          expiresAt,
        }),
        201,
      );
      return true;
    }
    ctx.error(res, "Family workflow route not found", 404);
    return true;
  } catch (error) {
    // error-policy:J1 HTTP boundary returns a structured failure.
    ctx.error(res, error instanceof Error ? error.message : String(error), 400);
    return true;
  }
}
