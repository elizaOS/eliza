import type http from "node:http";
import { validateNativeNotesReadReplyHint } from "@elizaos/contracts/native-notes-query";
import {
  AgentRuntime,
  ChannelType,
  type IAgentRuntime,
  runWithStreamingContext,
  type UUID,
} from "@elizaos/core";
import {
  ApprovalIdempotencyConflictError,
  ApprovalNotFoundError,
  type ApprovalRequest,
  ApprovalStateTransitionError,
  DEVICE_VIEWS,
  DeviceActionError,
  DeviceActionService,
  type DeviceCredential,
  type DeviceReadCompletionHint,
  deviceProposalDigest,
} from "@elizaos/plugin-assistant";
import type { AgentHttpRequestAuthorization } from "../runtime/host-bridge.ts";
import { getAgentHostBridge } from "../runtime/host-bridge.ts";
import {
  persistAssistantConversationMemory,
  resolveTrustedApiPrincipal,
} from "./chat-routes.ts";
import {
  createConversationStreamDisconnectTracker,
  resolvePairedSessionToken,
} from "./conversation-routes.ts";
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
  const allowedCapabilities = new Set([
    "calendar.local-event.v1",
    "calendar.create.v1",
    "calendar.next-read.v1",
    "notes.local-record.v1",
    "notes.query.v1",
    "reminders.local-record.v1",
    "reminders.local-record.v2",
    "reminders.create.v1",
    "maps.selected-read.v1",
    "clock.handoff.v1",
    "clock.handoff.v2",
    "clock.alarms.v1",
  ]);
  if (
    capabilities.length > allowedCapabilities.size ||
    (capabilities.includes("reminders.local-record.v1") &&
      capabilities.includes("reminders.local-record.v2")) ||
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some((value) => !allowedCapabilities.has(value))
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
  revalidateAuthorization?: () => Promise<AgentHttpRequestAuthorization>;
  assertRuntimeCurrent?: () => void;
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
            "notes.query.v1",
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
        proposals: await Promise.all(
          (await service.list(credential)).map(async (proposal) => {
            const digest = deviceProposalDigest(proposal);
            const pendingRead =
              proposal.state === "pending" &&
              proposal.expiresAt.getTime() > Date.now() &&
              proposal.payload.action === "device_action" &&
              ["notes_query", "notes_read_selected"].includes(
                proposal.payload.operation.type,
              );
            const readReplyOrigin = pendingRead
              ? await service.readReplyOrigin(credential, proposal.id, digest)
              : undefined;
            return {
              ...proposal,
              digest,
              ...(readReplyOrigin ? { readReplyOrigin } : {}),
            };
          }),
        ),
      });
      return true;
    }
    const completionMatch =
      /^\/api\/client-devices\/proposals\/([A-Za-z0-9_-]+)\/(read-completion|cancel-read-completion)$/.exec(
        pathname,
      );
    if (method === "POST" && completionMatch) {
      const body = await ctx.readJsonBody<Record<string, unknown>>(req, res);
      if (!body) return true;
      if (typeof body.digest !== "string")
        throw new DeviceActionError("Invalid read completion digest");
      if (completionMatch[2] === "cancel-read-completion") {
        if (Object.keys(body).some((key) => key !== "digest"))
          throw new DeviceActionError("Invalid read cancellation");
        await service.cancelReadReply(
          credential,
          completionMatch[1],
          body.digest,
        );
        json(res, { cancelled: true });
        return true;
      }
      if (!ctx.authorization?.ok || ctx.authorization.role !== "OWNER") {
        error(res, "Owner role required", 403);
        return true;
      }
      let hint: DeviceReadCompletionHint;
      try {
        hint = validateNativeNotesReadReplyHint(body);
      } catch {
        throw new DeviceActionError("Invalid original read completion");
      }
      if (hint.proposalId !== completionMatch[1])
        throw new DeviceActionError("Original read proposal changed");
      const retained = await service.readCompletionHint(
        credential,
        hint.proposalId,
        hint.digest,
        hint.attemptId,
      );
      if (
        !retained ||
        retained.digest !== hint.digest ||
        retained.attemptId !== hint.attemptId ||
        retained.requestId !== hint.requestId ||
        retained.conversationId !== hint.conversationId ||
        retained.inReplyTo !== hint.inReplyTo
      )
        throw new DeviceActionError("Original read completion changed");
      if (!(runtime instanceof AgentRuntime))
        throw new DeviceActionError(
          "Canonical reply host unavailable",
          "DEVICE_STORE_UNAVAILABLE",
        );
      const roomId = await service.readCompletionRoom(credential, retained);
      const pairedSessionToken = await resolvePairedSessionToken(
        req,
        resolveTrustedApiPrincipal(req, ctx.authorization),
        runtime,
      );
      const tracker = createConversationStreamDisconnectTracker({
        req,
        res,
        conversationId: retained.conversationId,
        roomId,
        continueOnDisconnect: false,
        pairedSessionToken,
        runtime,
      });
      const recheck = async () => {
        tracker.signal.throwIfAborted();
        const resolve = getAgentHostBridge().resolveHttpRequestAuthorization;
        const fresh = ctx.revalidateAuthorization
          ? await ctx.revalidateAuthorization()
          : resolve
            ? await resolve(req, runtime, {
                allowCookieAuth: true,
                allowTrustedLocalBypass: false,
                allowBearerAuth: true,
              })
            : null;
        const current = fresh ? deviceRequestCredential(req, fresh) : null;
        if (
          !fresh?.ok ||
          fresh.role !== "OWNER" ||
          current?.subjectUserId !== credential.subjectUserId ||
          current.installationId !== credential.installationId
        ) {
          tracker.abort(new Error("Original read owner authority retired"));
          throw new DeviceActionError("Original read owner authority retired");
        }
        tracker.signal.throwIfAborted();
      };
      try {
        if (!(await tracker.authorityReady))
          throw new DeviceActionError("Read completion authority retired");
        const reply = await runtime.turnControllers.runWith(
          roomId,
          (turnSignal) => {
            const signal = AbortSignal.any([tracker.signal, turnSignal]);
            return runtime.roomHandlerQueue.withLease(
              roomId,
              (lease) =>
                runWithStreamingContext({ abortSignal: signal }, () =>
                  service.completeReadReply(
                    credential,
                    retained,
                    signal,
                    async (reply, current, assertCurrent) => {
                      assertCurrent();
                      await persistAssistantConversationMemory(
                        runtime,
                        roomId,
                        {
                          text: reply.text,
                          inReplyTo: reply.inReplyTo as UUID,
                          source: "client_chat",
                          channelType: ChannelType.API,
                          agentVoiced: true,
                          metadata: {
                            deviceReadCompletion: {
                              proposalId: retained.proposalId,
                              attemptId: retained.attemptId,
                              requestId: retained.requestId,
                            },
                          },
                        },
                        ChannelType.API,
                        undefined,
                        reply.messageId as UUID,
                        lease,
                        assertCurrent,
                      );
                      current.throwIfAborted();
                    },
                    recheck,
                    ctx.assertRuntimeCurrent,
                  ),
                ),
              { signal },
            );
          },
        );
        tracker.signal.throwIfAborted();
        tracker.markCompleted();
        json(res, { reply });
        return true;
      } catch (cause) {
        tracker.abort(
          cause instanceof Error
            ? cause
            : new Error("Original read completion retired"),
        );
        throw cause;
      } finally {
        if (tracker.signal.aborted) {
          try {
            await service.cancelReadReply(
              credential,
              retained.proposalId,
              retained.digest,
            );
          } catch {
            runtime.reportError(
              "DeviceReadCompletion",
              new Error("Completion cancellation could not be confirmed"),
              {
                code: "DEVICE_READ_COMPLETION_RETIREMENT_UNCONFIRMED",
                proposalId: retained.proposalId,
              },
            );
          }
        }
        tracker.dispose();
      }
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
