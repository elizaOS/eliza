import type { ChannelContribution } from "./channels/contract.js";
import type { DispatchResult } from "./connectors/contract.js";

export type LifeOpsSensitiveRequestKind =
  | "secret"
  | "payment"
  | "oauth"
  | "private_info";

export interface LifeOpsSensitiveRequestDeliveryPlan {
  kind: LifeOpsSensitiveRequestKind;
  mode:
    | "inline_owner_app"
    | "private_dm"
    | "cloud_authenticated_link"
    | "tunnel_authenticated_link"
    | "public_link"
    | "dm_or_owner_app_instruction";
  privateRouteRequired: boolean;
  publicLinkAllowed: boolean;
  authenticated: boolean;
  linkBaseUrl?: string;
}

export interface LifeOpsSensitiveRequestInlineFormDescriptor {
  type: "sensitive_request_form";
  kind: LifeOpsSensitiveRequestKind;
  mode: "inline_owner_app";
  fields: Array<{
    name: string;
    label: string;
    input: "secret" | "text" | "email" | "url";
    required: boolean;
  }>;
  submitLabel: string;
  statusOnly: true;
}

export interface LifeOpsSensitiveRequestDeliveryRecord {
  id: string;
  kind: LifeOpsSensitiveRequestKind;
  status: "pending" | "fulfilled" | "failed" | "canceled" | "expired";
  delivery: LifeOpsSensitiveRequestDeliveryPlan;
  expiresAt?: string;
}

export interface SensitiveRequestPrivateDeliveryResult {
  dispatchResult: DispatchResult;
  publicStatusText: string;
  privateText: string;
}

export interface DeliverPrivateSensitiveRequestArgs {
  request: LifeOpsSensitiveRequestDeliveryRecord;
  channel: Pick<ChannelContribution, "kind" | "capabilities" | "send"> | null;
  target: string | null | undefined;
  form?: LifeOpsSensitiveRequestInlineFormDescriptor;
}

const SETUP_NOUN: Record<LifeOpsSensitiveRequestKind, string> = {
  secret: "setup request",
  payment: "payment request",
  oauth: "account connection request",
  private_info: "private information request",
};

function failure(
  reason: Extract<DispatchResult, { ok: false }>["reason"],
  message: string,
  userActionable = true,
): DispatchResult {
  return {
    ok: false,
    reason,
    userActionable,
    message,
  };
}

function requestLink(
  request: LifeOpsSensitiveRequestDeliveryRecord,
): string | null {
  const base = request.delivery.linkBaseUrl?.trim();
  if (!base) return null;
  const slash = base.endsWith("/") ? "" : "/";
  return `${base}${slash}sensitive-requests/${encodeURIComponent(request.id)}`;
}

export function publicSensitiveRequestStatusText(
  request: Pick<LifeOpsSensitiveRequestDeliveryRecord, "kind">,
  result: DispatchResult,
): string {
  const noun = SETUP_NOUN[request.kind];
  if (result.ok) {
    return `I sent a private ${noun}.`;
  }
  return `I could not send the private ${noun}. Please DM me or open the owner app as the owner.`;
}

export function privateSensitiveRequestText(
  request: LifeOpsSensitiveRequestDeliveryRecord,
): string {
  const noun = SETUP_NOUN[request.kind];
  const link = requestLink(request);
  if (link) {
    return `Open this private ${noun} to continue: ${link}`;
  }
  if (request.delivery.mode === "inline_owner_app") {
    return `Open the owner app to complete this private ${noun}.`;
  }
  return `Complete this private ${noun} in this DM or in the owner app.`;
}

function buildPayload(args: DeliverPrivateSensitiveRequestArgs, text: string) {
  return {
    target: args.target?.trim() ?? "",
    message: text,
    metadata: {
      sensitiveRequest: {
        id: args.request.id,
        kind: args.request.kind,
        status: args.request.status,
        delivery: {
          mode: args.request.delivery.mode,
          privateRouteRequired: args.request.delivery.privateRouteRequired,
          publicLinkAllowed: args.request.delivery.publicLinkAllowed,
          authenticated: args.request.delivery.authenticated,
        },
        expiresAt: args.request.expiresAt,
      },
      form: args.form,
    },
  };
}

export async function deliverPrivateSensitiveRequest(
  args: DeliverPrivateSensitiveRequestArgs,
): Promise<SensitiveRequestPrivateDeliveryResult> {
  const privateText = privateSensitiveRequestText(args.request);
  let dispatchResult: DispatchResult;

  if (!args.channel) {
    dispatchResult = failure(
      "disconnected",
      "No private channel is available for sensitive request delivery.",
    );
  } else if (!args.channel.capabilities.send || !args.channel.send) {
    dispatchResult = failure(
      "disconnected",
      `Channel "${args.channel.kind}" cannot send private sensitive requests.`,
    );
  } else if (!args.target || args.target.trim().length === 0) {
    dispatchResult = failure(
      "unknown_recipient",
      "No private recipient is available for sensitive request delivery.",
    );
  } else {
    try {
      dispatchResult = await args.channel.send(buildPayload(args, privateText));
    } catch {
      dispatchResult = failure(
        "transport_error",
        `Channel "${args.channel.kind}" failed to send the private sensitive request.`,
        false,
      );
    }
  }

  return {
    dispatchResult,
    publicStatusText: publicSensitiveRequestStatusText(
      args.request,
      dispatchResult,
    ),
    privateText,
  };
}
