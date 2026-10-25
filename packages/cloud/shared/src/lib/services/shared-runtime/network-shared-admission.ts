/** Default-off server admission for Network context on the existing Personal ingress.
 * This never authenticates a phone as a Cloud user or grants model-owned effects.
 */
import {
  type ApprovedRelayPhoto,
  type NetworkTransport,
  parseApprovedRelayPhotos,
} from "@elizaos/plugin-network/contract";
import { z } from "zod";

export interface NetworkIngressScope {
  project: string;
  platform: "blooio" | "twilio";
  connectorAccountId: string;
  phoneNumber: string;
  messageId: string;
  message: string;
  transport?: NetworkTransport;
}
export interface NetworkOwnedAccount {
  userId: string;
  organizationId: string;
  agentId: string;
  roomId: string;
}
export interface NetworkAdmissionPolicy {
  phoneNumber: string;
  project: "eliza-app";
  platform: "blooio" | "twilio";
  connectorAccountId: string;
  messageIdPrefix: string;
  userId: string;
  organizationId: string;
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
export function parseNetworkAdmissionPolicy(
  raw: string | undefined,
): NetworkAdmissionPolicy | undefined {
  if (!raw || raw.length > 2048) return undefined;
  try {
    const p = JSON.parse(raw) as NetworkAdmissionPolicy;
    if (
      !p ||
      typeof p !== "object" ||
      Array.isArray(p) ||
      Object.keys(p).sort().join() !==
        [
          "phoneNumber",
          "project",
          "platform",
          "connectorAccountId",
          "messageIdPrefix",
          "userId",
          "organizationId",
        ]
          .sort()
          .join() ||
      p.project !== "eliza-app" ||
      typeof p.phoneNumber !== "string" ||
      !/^\+[1-9]\d{6,14}$/u.test(p.phoneNumber) ||
      p.messageIdPrefix !== `${p.platform}:${p.project}:` ||
      !["blooio", "twilio"].includes(p.platform) ||
      typeof p.connectorAccountId !== "string" ||
      !p.connectorAccountId.trim() ||
      p.connectorAccountId.length > 160 ||
      typeof p.messageIdPrefix !== "string" ||
      !p.messageIdPrefix ||
      p.messageIdPrefix.length > 80 ||
      typeof p.userId !== "string" ||
      typeof p.organizationId !== "string" ||
      !UUID.test(p.userId) ||
      !UUID.test(p.organizationId)
    )
      return undefined;
    return p;
  } catch {
    // error-policy:J3 malformed policy or signed JSON grants no admission.
    return undefined;
  }
}
/** Invoked before any account resolution; a signature is still required separately. */
export function networkIngressMatchesPolicy(
  ingress: NetworkIngressScope,
  policy: NetworkAdmissionPolicy | undefined,
  enabled: string | undefined,
): boolean {
  return (
    enabled === "true" &&
    !!policy &&
    ingress.project === policy.project &&
    ingress.platform === policy.platform &&
    ingress.connectorAccountId === policy.connectorAccountId &&
    ingress.phoneNumber === policy.phoneNumber &&
    ingress.messageId.startsWith(policy.messageIdPrefix) &&
    ingress.messageId.length > policy.messageIdPrefix.length &&
    /^\+[1-9]\d{6,14}$/u.test(ingress.phoneNumber) &&
    !!ingress.message.trim()
  );
}
/** Existing verified-phone resolution owns these IDs; no Network ID replaces them. */
export function networkAccountMatchesPolicy(
  account: NetworkOwnedAccount,
  policy: NetworkAdmissionPolicy,
): boolean {
  return (
    account.userId === policy.userId &&
    account.organizationId === policy.organizationId &&
    UUID.test(account.userId) &&
    UUID.test(account.organizationId) &&
    !!account.agentId &&
    account.roomId === account.agentId
  );
}

/** Branded in-memory capability. Serialization drops authority; the DO must verify again. */
declare const networkAdmissionBrand: unique symbol;
export interface VerifiedNetworkAdmission {
  readonly [networkAdmissionBrand]: true;
  readonly turn: unknown;
  readonly ingress: NetworkIngressScope & {
    readonly transport: NetworkTransport;
  };
}
const admitted = new WeakSet<object>();
export function isVerifiedNetworkAdmission(value: unknown): value is VerifiedNetworkAdmission {
  return !!value && typeof value === "object" && admitted.has(value);
}
/** The service's OPEN decision owns age/invite/current membership admission.
 * Each effect is independently rechecked by the Network service. Cloud still
 * verifies original request bytes and exact connector/sender/message binding.
 */
export async function verifyNetworkOpenAdmission(input: {
  originalBody: string;
  headers: Headers;
  path: string;
  service: string;
  secret: string | undefined;
  enabled: string | undefined;
  policy: NetworkAdmissionPolicy | undefined;
  ingress: NetworkIngressScope;
  turn: unknown;
}): Promise<VerifiedNetworkAdmission | undefined> {
  if (
    input.path !== "/api/internal/eliza-app/personal-shared/messages" ||
    typeof input.originalBody !== "string" ||
    new TextEncoder().encode(input.originalBody).byteLength > 32768 ||
    !input.policy ||
    input.service !== "webhook-gateway" ||
    !networkIngressMatchesPolicy(input.ingress, input.policy, input.enabled)
  )
    return undefined;
  const { svcVerify } = await import("@elizaos/plugin-network/svc-auth");
  const { parseServiceTurn } = await import("@elizaos/plugin-network");
  const turn = parseServiceTurn(input.turn);
  if (
    !turn ||
    turn.channel !== input.ingress.platform ||
    input.ingress.messageId !== input.policy.messageIdPrefix + turn.messageId
  )
    return undefined;
  const proof = await svcVerify(input.secret, {
    method: "POST",
    path: input.path,
    headers: input.headers,
    body: input.originalBody,
  });
  if (!proof.ok || proof.id !== turn.messageId) return undefined;
  let original: unknown;
  try {
    original = JSON.parse(input.originalBody);
  } catch {
    // error-policy:J3 malformed policy or signed JSON grants no admission.
    return undefined;
  }
  if (!original || typeof original !== "object") return undefined;
  const body = original as Record<string, unknown>;
  if (
    body.networkHandled !== undefined ||
    ["chatId", "groupId", "membershipChange", "agentId", "eventType", "chatType"].some(
      (key) => body[key] !== undefined,
    ) ||
    typeof body.transport !== "string" ||
    !["imessage", "sms", "rcs", "unknown"].includes(body.transport) ||
    body.platform !== input.ingress.platform ||
    body.project !== input.ingress.project ||
    body.connectorAccountId !== input.ingress.connectorAccountId ||
    body.phoneNumber !== input.ingress.phoneNumber ||
    body.messageId !== input.ingress.messageId ||
    body.message !== input.ingress.message ||
    JSON.stringify(body.networkTurn) !== JSON.stringify(input.turn)
  )
    return undefined;
  const value = {
    turn,
    ingress: {
      ...input.ingress,
      transport: body.transport as NetworkTransport,
    },
  } as unknown as VerifiedNetworkAdmission;
  admitted.add(value);
  return value;
}

export interface NetworkAdmissionEnvelope {
  originalBody: string;
  path: string;
  signatureHeaders: Record<string, string>;
}
export async function verifyNetworkAdmissionEnvelope(
  envelope: NetworkAdmissionEnvelope,
  bindings: {
    SERVICE_TURN_SECRET?: string;
    NETWORK_PERSONAL_CONTINUITY_ENABLED?: string;
    NETWORK_OWNED_INGRESS_POLICY?: string;
  },
): Promise<VerifiedNetworkAdmission | undefined> {
  if (
    typeof envelope.originalBody !== "string" ||
    new TextEncoder().encode(envelope.originalBody).byteLength > 32768 ||
    envelope.path !== "/api/internal/eliza-app/personal-shared/messages"
  )
    return undefined;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(envelope.originalBody);
  } catch {
    // error-policy:J3 malformed policy or signed JSON grants no admission.
    return undefined;
  }
  if (!body || typeof body !== "object" || !["blooio", "twilio"].includes(String(body.platform)))
    return undefined;
  const ingress = body as unknown as NetworkIngressScope;
  if (
    [
      ingress.project,
      ingress.connectorAccountId,
      ingress.phoneNumber,
      ingress.messageId,
      ingress.message,
    ].some((x) => typeof x !== "string")
  )
    return undefined;
  return verifyNetworkOpenAdmission({
    originalBody: envelope.originalBody,
    headers: new Headers(envelope.signatureHeaders),
    path: envelope.path,
    service: "webhook-gateway",
    secret: bindings.SERVICE_TURN_SECRET,
    enabled: bindings.NETWORK_PERSONAL_CONTINUITY_ENABLED,
    policy: parseNetworkAdmissionPolicy(bindings.NETWORK_OWNED_INGRESS_POLICY),
    ingress,
    turn: body.networkTurn,
  });
}

const handledSchema = z.object({
  request: z
    .object({
      messageId: z.string().min(1).max(200),
      channel: z.enum(["blooio", "twilio"]),
      from: z.string(),
      to: z.string().nullable(),
      text: z.string(),
      transport: z.enum(["imessage", "sms", "rcs", "unknown"]),
      receivedAt: z.number().int().positive(),
      app: z.enum(["ntwrk", "slop", "peon", "friends"]).optional(),
    })
    .strict(),
  response: z
    .object({
      outcome: z.literal("handled"),
      replies: z.array(z.string().min(1)).max(16),
      replyIds: z.array(z.string().min(1)).max(16),
      delivery: z.literal("collected"),
      replyKind: z.enum(["reply", "compliance"]),
      accountEligible: z.boolean(),
      reason: z.string(),
      app: z.enum(["ntwrk", "slop", "peon", "friends"]).nullable(),
      memberId: z.string().nullable(),
      consent: z
        .object({
          state: z.enum(["opted_out", "opted_in"]),
          scope: z.enum(["all", "app"]),
          app: z.enum(["ntwrk", "slop", "peon", "friends"]).nullable(),
          at: z.number().int().positive(),
        })
        .strict()
        .optional(),
    })
    .strict(),
});
export type NetworkHandled = z.infer<typeof handledSchema>;
/** Reverification is required at each process boundary, before account creation or delivery. */
export async function verifyNetworkHandledEnvelope(
  envelope: NetworkAdmissionEnvelope,
  bindings: {
    SERVICE_TURN_SECRET?: string;
    NETWORK_PERSONAL_CONTINUITY_ENABLED?: string;
    NETWORK_OWNED_INGRESS_POLICY?: string;
  },
): Promise<{ ingress: NetworkIngressScope; handled: NetworkHandled } | undefined> {
  if (
    envelope.path !== "/api/internal/eliza-app/personal-shared/messages" ||
    typeof envelope.originalBody !== "string" ||
    new TextEncoder().encode(envelope.originalBody).byteLength > 32768
  )
    return undefined;
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(envelope.originalBody);
  } catch {
    // error-policy:J3 malformed policy or signed JSON grants no admission.
    return undefined;
  }
  if (
    !b ||
    typeof b !== "object" ||
    b.networkTurn !== undefined ||
    ["chatId", "groupId", "membershipChange", "agentId", "eventType", "chatType"].some(
      (key) => b[key] !== undefined,
    )
  )
    return undefined;
  const ingress = b as unknown as NetworkIngressScope;
  if (
    [
      ingress.project,
      ingress.connectorAccountId,
      ingress.phoneNumber,
      ingress.messageId,
      ingress.message,
    ].some((x) => typeof x !== "string")
  )
    return undefined;
  const policy = parseNetworkAdmissionPolicy(bindings.NETWORK_OWNED_INGRESS_POLICY);
  if (!networkIngressMatchesPolicy(ingress, policy, bindings.NETWORK_PERSONAL_CONTINUITY_ENABLED))
    return undefined;
  const h = handledSchema.safeParse(b.networkHandled);
  if (!h.success) return undefined;
  const { request: r, response: a } = h.data;
  const { svcVerify } = await import("@elizaos/plugin-network/svc-auth");
  const proof = await svcVerify(bindings.SERVICE_TURN_SECRET, {
    method: "POST",
    path: envelope.path,
    headers: new Headers(envelope.signatureHeaders),
    body: envelope.originalBody,
  });
  if (
    !proof.ok ||
    proof.id !== r.messageId ||
    r.from !== ingress.phoneNumber ||
    r.channel !== ingress.platform ||
    ingress.messageId !== policy!.messageIdPrefix + r.messageId ||
    r.text !== ingress.message ||
    b.transport !== r.transport ||
    a.replies.length !== a.replyIds.length ||
    new Set(a.replyIds).size !== a.replyIds.length ||
    a.replies.some((t) => !t.trim()) ||
    a.replies.join("\n\n").length > 1600
  )
    return undefined;
  return { ingress, handled: h.data };
}

const serviceDeliverySchema = z
  .object({
    approvedPhotos: z
      .custom<ApprovedRelayPhoto[]>((v) => parseApprovedRelayPhotos(v) !== undefined)
      .optional(),
    id: z.string().min(1).max(200),
    to: z.string().regex(/^\+[1-9]\d{6,14}$/u),
    from: z.string().nullable().optional(),
    text: z.string().min(1).max(1600),
    app: z.enum(["ntwrk", "slop", "peon", "friends"]),
    memberId: z.string().nullable(),
    channel: z.enum(["blooio", "twilio"]).optional(),
    kind: z.enum(["reply", "proactive", "relay"]),
  })
  .strict();
export type NetworkServiceDelivery = z.infer<typeof serviceDeliverySchema>;
/** Backend queue delivery is separate authority from a Gateway-attested OPEN turn. */
export async function verifyNetworkServiceDeliveryEnvelope(
  envelope: NetworkAdmissionEnvelope,
  bindings: {
    SERVICE_TURN_SECRET?: string;
    NETWORK_RELAY_ENABLED?: string;
    NETWORK_PERSONAL_CONTINUITY_ENABLED?: string;
    NETWORK_OWNED_INGRESS_POLICY?: string;
  },
): Promise<{ delivery: NetworkServiceDelivery; policy: NetworkAdmissionPolicy } | undefined> {
  if (
    !["/api/internal/network/deliver", "/api/internal/network/deliver/receipt"].includes(
      envelope.path,
    ) ||
    typeof envelope.originalBody !== "string" ||
    new TextEncoder().encode(envelope.originalBody).byteLength > 8192 ||
    bindings.NETWORK_PERSONAL_CONTINUITY_ENABLED !== "true"
  )
    return undefined;
  const policy = parseNetworkAdmissionPolicy(bindings.NETWORK_OWNED_INGRESS_POLICY);
  if (!policy) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(envelope.originalBody);
  } catch {
    // error-policy:J3 malformed policy or signed JSON grants no admission.
    return undefined;
  }
  const parsed = serviceDeliverySchema.safeParse(raw);
  if (
    !parsed.success ||
    !parsed.data.text.trim() ||
    parsed.data.to !== policy.phoneNumber ||
    (parsed.data.channel ?? "blooio") !== policy.platform
  )
    return undefined;
  const photos = parsed.data.approvedPhotos && parseApprovedRelayPhotos(parsed.data.approvedPhotos);
  if (
    parsed.data.approvedPhotos !== undefined &&
    (!photos ||
      (bindings.NETWORK_RELAY_ENABLED !== "1" && !envelope.path.endsWith("/receipt")) ||
      parsed.data.kind !== "relay" ||
      parsed.data.channel === "twilio" ||
      photos.some(
        (p) =>
          p.app !== parsed.data.app ||
          p.recipientMemberId !== parsed.data.memberId ||
          `relay:${p.itemId}` !== parsed.data.id,
      ))
  )
    return undefined;
  const { svcVerify } = await import("@elizaos/plugin-network/svc-auth");
  const proof = await svcVerify(bindings.SERVICE_TURN_SECRET, {
    method: "POST",
    path: envelope.path,
    headers: new Headers(envelope.signatureHeaders),
    body: envelope.originalBody,
  });
  if (!proof.ok || proof.id !== parsed.data.id) return undefined;
  return { delivery: { ...parsed.data, ...(photos ? { approvedPhotos: photos } : {}) }, policy };
}
