import type http from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import {
  ApprovalIdempotencyConflictError,
  ApprovalNotFoundError,
  type ApprovalRequest,
  ApprovalStateTransitionError,
  DEVICE_VIEWS,
  DeviceActionError,
  DeviceActionService,
  type DeviceCredential,
  deviceProposalDigest,
} from "@elizaos/plugin-assistant";
import type { AgentHttpRequestAuthorization } from "../runtime/host-bridge.ts";
import { workflowDeviceOwner } from "./workflow-device-owner.ts";

export function requiresDeviceIdentity(
  req: Pick<http.IncomingMessage, "headers">,
  pathname: string,
): boolean {
  return (
    pathname.startsWith("/api/client-devices") ||
    req.headers["x-eliza-device-id"] !== undefined ||
    req.headers["x-eliza-device-key"] !== undefined
  );
}

export function deviceRequestCredential(
  req: http.IncomingMessage,
  authorization?: AgentHttpRequestAuthorization,
): DeviceCredential | null {
  const installationId = req.headers["x-eliza-device-id"];
  const deviceKey = req.headers["x-eliza-device-key"];
  if (
    !authorization?.ok ||
    (!authorization.identityId && !authorization.principal) ||
    !["USER", "ADMIN", "OWNER"].includes(authorization.role) ||
    typeof installationId !== "string" ||
    typeof deviceKey !== "string"
  )
    return null;
  const capabilityHeader = req.headers["x-eliza-device-capabilities"];
  if (capabilityHeader !== undefined && typeof capabilityHeader !== "string")
    return null;
  if (typeof capabilityHeader === "string" && /[\r\n]/.test(capabilityHeader))
    return null;
  const capabilities =
    typeof capabilityHeader === "string"
      ? capabilityHeader.split(",").map((value) => value.trim())
      : [];
  if (
    capabilities.length > 10 ||
    (capabilities.includes("reminders.local-record.v1") &&
      capabilities.includes("reminders.local-record.v2")) ||
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some(
      (value) =>
        ![
          "calendar.local-event.v1",
          "calendar.create.v1",
          "calendar.next-read.v1",
          "notes.local-record.v1",
          "reminders.local-record.v1",
          "reminders.local-record.v2",
          "reminders.create.v1",
          "maps.selected-read.v1",
          "clock.handoff.v1",
          "clock.handoff.v2",
          "clock.alarms.v1",
        ].includes(value),
    )
  )
    return null;
  return {
    capabilities,
    subjectUserId:
      authorization.identityId ?? `gateway:${authorization.principal}`,
    installationId,
    deviceKey,
  };
}
interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  runtime: IAgentRuntime | null;
  authorization?: AgentHttpRequestAuthorization;
  json(res: http.ServerResponse, value: unknown, status?: number): void;
  error(res: http.ServerResponse, message: string, status?: number): void;
  readJsonBody<T>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<T | null>;
}
export async function handleDeviceActionRoutes(
  ctx: RouteContext,
): Promise<boolean> {
  if (!ctx.pathname.startsWith("/api/client-devices")) return false;
  const { req, res, method, pathname, runtime, json, error } = ctx;
  if (!runtime) {
    error(res, "Agent unavailable", 503);
    return true;
  }
  const credential = deviceRequestCredential(req, ctx.authorization);
  if (!credential) {
    error(res, "Authenticated device session required", 401);
    return true;
  }
  const service = new DeviceActionService(runtime);
  try {
    if (method === "GET" && pathname === "/api/client-devices/capabilities") {
      // Only the verified gateway bridge can advertise Cloud owner parity.
      // Route presence alone must not turn a shared bearer into a Cloud owner.
      const identity = ctx.authorization?.externalIdentity;
      if (!identity || !ctx.authorization?.identityId) {
        error(res, "Verified Cloud owner capabilities unavailable", 503);
        return true;
      }
      json(res, {
        protocol: 1,
        agentId: runtime.agentId,
        identityId: ctx.authorization.identityId,
        externalIdentity: identity,
        deviceActions: {
          protocol: 1,
          capabilities: [
            "calendar.local-event.v1",
            "calendar.create.v1",
            "calendar.next-read.v1",
            "notes.local-record.v1",
            "reminders.local-record.v1",
            "reminders.local-record.v2",
            "reminders.create.v1",
            "maps.selected-read.v1",
            "clock.handoff.v1",
            "clock.handoff.v2",
            "clock.alarms.v1",
          ],
        },
      });
      return true;
    }
    if (method === "GET" && pathname === "/api/client-devices/context") {
      json(res, await service.context(credential));
      return true;
    }
    if (pathname === "/api/client-devices/view-profile") {
      if (method === "GET") {
        json(res, {
          version: 1,
          supportedViews: DEVICE_VIEWS,
          profile: await service.viewProfile(credential),
        });
        return true;
      }
      if (method === "POST") {
        const body = await ctx.readJsonBody<unknown>(req, res);
        if (body)
          json(res, {
            version: 1,
            profile: await service.setViewProfile(credential, body),
          });
        return true;
      }
    }
    if (method === "POST" && pathname === "/api/client-devices/register") {
      const body = await ctx.readJsonBody<{
        label: string;
        workflowProtocol?: 0 | 1 | 2;
      }>(req, res);
      if (body)
        json(
          res,
          await service.register(
            credential,
            body.label,
            body.workflowProtocol ?? 0,
            workflowDeviceOwner(
              runtime,
              ctx.authorization,
              credential.subjectUserId,
            ),
          ),
        );
      return true;
    }
    if (method === "POST" && pathname === "/api/client-devices/revoke") {
      await service.revoke(credential);
      json(res, { revoked: true });
      return true;
    }
    if (method === "GET" && pathname === "/api/client-devices/proposals") {
      json(res, {
        proposals: (await service.list(credential)).map((proposal) => ({
          ...proposal,
          digest: deviceProposalDigest(proposal),
        })),
      });
      return true;
    }
    const match =
      /^\/api\/client-devices\/proposals\/([A-Za-z0-9_-]+)\/(decision|claim|receipt|reconciliation)$/.exec(
        pathname,
      );
    if (method === "POST" && match) {
      const body = await ctx.readJsonBody<{
        digest: string;
        decision?: string;
        attemptId?: string;
        receipt?: unknown;
        resolution?: unknown;
      }>(req, res);
      if (!body) return true;
      let proposal: ApprovalRequest;
      if (match[2] === "decision") {
        if (body.decision !== "approve" && body.decision !== "reject")
          throw new DeviceActionError("Invalid decision");
        proposal = await service.decide(
          credential,
          match[1],
          body.digest,
          body.decision === "approve",
        );
      } else if (match[2] === "claim") {
        proposal = await service.claim(credential, match[1], body.digest);
      } else if (match[2] === "reconciliation") {
        proposal = await service.reconcile(
          credential,
          match[1],
          body.digest,
          body.attemptId ?? "",
          body.resolution,
        );
      } else {
        proposal = await service.receipt(
          credential,
          match[1],
          body.digest,
          body.attemptId ?? "",
          body.receipt,
        );
      }
      json(res, { proposal, digest: deviceProposalDigest(proposal) });
      return true;
    }
    error(res, "Device route not found", 404);
  } catch (cause) {
    if (
      cause instanceof DeviceActionError ||
      cause instanceof ApprovalIdempotencyConflictError ||
      cause instanceof ApprovalStateTransitionError ||
      cause instanceof ApprovalNotFoundError
    ) {
      error(
        res,
        "Device request rejected or state changed",
        cause instanceof DeviceActionError &&
          cause.code === "DEVICE_STORE_UNAVAILABLE"
          ? 503
          : 409,
      );
    } else {
      // Raw SQL diagnostics can contain note content. Emit only a fixed incident code.
      runtime.reportError(
        "DeviceActionService",
        new Error("Device store operation failed"),
        { code: "DEVICE_STORE_FAILURE" },
      );
      error(res, "Device store temporarily unavailable", 503);
    }
  }
  return true;
}
