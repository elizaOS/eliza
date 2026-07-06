/**
 * iMessage delivery adapter for sensitive requests.
 *
 * Secrets and OAuth grants must never be collected through the chat text
 * transport. This adapter sends only the secure entry link or fallback
 * instruction through the existing iMessage service and reports explicit
 * delivery failures when no handle or service is available.
 */

import {
  type DeliveryResult,
  type DispatchSensitiveRequest,
  type IAgentRuntime,
  logger,
  type SensitiveRequest,
  type SensitiveRequestDeliveryAdapter,
} from "@elizaos/core";
import { IMessageService } from "./service.js";

type IMessageDispatchRequest = DispatchSensitiveRequest & Partial<SensitiveRequest>;

const SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE_NAME = "SensitiveRequestDispatchRegistry";

function resolveTargetHandle(
  request: IMessageDispatchRequest,
  channelId?: string
): string | undefined {
  const candidate = channelId ?? request.requesterEntityId ?? request.originUserId;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}

function resolveLink(request: IMessageDispatchRequest): string | undefined {
  return request.callback?.url ?? request.delivery?.linkBaseUrl ?? undefined;
}

function buildSensitiveRequestText(request: IMessageDispatchRequest): string {
  const reason = request.delivery?.reason ?? "A sensitive value is required.";
  const instruction =
    request.delivery?.instruction ?? "Please open the Eliza app to provide this value.";
  const link = resolveLink(request);
  const lines = ["A sensitive value is needed to continue.", reason];
  lines.push(link ? `Open this secure link to provide it: ${link}` : instruction);
  if (request.expiresAt) {
    lines.push(`This request expires at ${request.expiresAt}.`);
  }
  return lines.join("\n");
}

async function deliverViaIMessage(args: {
  request: DispatchSensitiveRequest;
  channelId?: string;
  runtime: unknown;
}): Promise<DeliveryResult> {
  const runtime = args.runtime as IAgentRuntime;
  const request = args.request as IMessageDispatchRequest;
  const target = resolveTargetHandle(request, args.channelId);
  if (!target) {
    return {
      delivered: false,
      target: "dm",
      error: "No iMessage handle available (need targetChannelId or originUserId)",
    };
  }

  const service = runtime.getService?.(IMessageService.serviceType) as
    | IMessageService
    | null
    | undefined;
  if (!service) {
    return { delivered: false, target: "dm", error: "iMessage service unavailable" };
  }

  try {
    const result = await service.sendMessage(target, buildSensitiveRequestText(request));
    if (!result.success) {
      return {
        delivered: false,
        target: "dm",
        channelId: target,
        error: result.error ?? "iMessage send failed",
      };
    }
    return {
      delivered: true,
      target: "dm",
      channelId: target,
      url: resolveLink(request),
      expiresAt: request.expiresAt,
    };
  } catch (err) {
    // error-policy:J1 boundary translation — adapter delivery reports a typed failure result.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { src: "imessage:sensitive-request-adapter", err: message },
      "Failed to deliver sensitive request via iMessage"
    );
    return { delivered: false, target: "dm", channelId: target, error: message };
  }
}

export const imessageDmSensitiveRequestAdapter: SensitiveRequestDeliveryAdapter = {
  target: "dm",
  supportsChannel: (_channelId, runtime) =>
    Boolean((runtime as IAgentRuntime | undefined)?.getService?.(IMessageService.serviceType)),
  deliver: (args) => deliverViaIMessage(args),
};

interface DispatchRegistryLike {
  register: (adapter: SensitiveRequestDeliveryAdapter) => void;
}

export function registerIMessageDmSensitiveRequestAdapter(runtime: IAgentRuntime): void {
  const tryRegister = (): boolean => {
    const registry = runtime.getService?.(SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE_NAME) as
      | DispatchRegistryLike
      | null
      | undefined;
    if (!registry || typeof registry.register !== "function") return false;
    try {
      registry.register(imessageDmSensitiveRequestAdapter);
      return true;
    } catch (err) {
      // error-policy:J1 boundary translation — plugin init must continue while the registry observes no adapter.
      logger.warn(
        {
          src: "imessage:sensitive-request-adapter",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register iMessage DM adapter with SensitiveRequestDispatchRegistry"
      );
      return true;
    }
  };

  if (tryRegister()) return;
  setImmediate(() => {
    tryRegister();
  });
}
