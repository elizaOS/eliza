import {
  redactSensitiveRequestMetadata,
  type SensitiveRequestEvent,
  type SensitiveRequestPolicy,
} from "@elizaos/core";
import {
  authorizeSensitiveRequestActor,
  createCloudSensitiveRequestAuthorizationAdapter,
  type SensitiveRequestAuthorizationDecision,
  type SensitiveRequestIdentityAuthorizationAdapter,
} from "@/lib/services/sensitive-request-authorization";

export interface OAuthSensitiveRequestBindingInput {
  requestId?: string;
  organizationId?: string;
  ownerUserId?: string;
  ownerEntityId?: string;
  policy?: SensitiveRequestPolicy;
  expectedProviderUserId?: string;
  expectedProviderEmail?: string;
  expectedProviderUsername?: string;
  allowUnlinkedProviderIdentity?: boolean;
}

export interface OAuthSensitiveRequestStateBinding {
  requestId: string;
  providerId: string;
  organizationId: string;
  ownerUserId?: string;
  ownerEntityId?: string;
  policy: SensitiveRequestPolicy;
  expectedProviderUserId?: string;
  expectedProviderEmail?: string;
  expectedProviderUsername?: string;
  allowUnlinkedProviderIdentity?: boolean;
  createdAt: number;
}

export interface OAuthCallbackProviderIdentity {
  id: string;
  email?: string;
  username?: string;
  displayName?: string;
}

export interface OAuthSensitiveRequestAuthorizationResult {
  decision: SensitiveRequestAuthorizationDecision;
  event?: SensitiveRequestEvent;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeEmail(value: unknown): string | undefined {
  return normalizeString(value)?.toLowerCase();
}

function defaultOAuthSensitiveRequestPolicy(): SensitiveRequestPolicy {
  return {
    actor: "owner_or_linked_identity",
    requirePrivateDelivery: false,
    requireAuthenticatedLink: true,
    allowInlineOwnerAppEntry: true,
    allowPublicLink: true,
    allowDmFallback: true,
    allowTunnelLink: true,
    allowCloudLink: true,
  };
}

export function createOAuthSensitiveRequestStateBinding(params: {
  providerId: string;
  organizationId: string;
  userId: string;
  binding?: OAuthSensitiveRequestBindingInput;
  now?: number;
}): OAuthSensitiveRequestStateBinding | undefined {
  if (!params.binding) return undefined;

  const requestId = normalizeString(params.binding.requestId) ?? crypto.randomUUID();
  const organizationId = normalizeString(params.binding.organizationId) ?? params.organizationId;
  if (organizationId !== params.organizationId) {
    throw new Error("SENSITIVE_REQUEST_ORGANIZATION_MISMATCH");
  }

  const ownerUserId = normalizeString(params.binding.ownerUserId) ?? params.userId;
  if (ownerUserId !== params.userId) {
    throw new Error("SENSITIVE_REQUEST_OWNER_USER_MISMATCH");
  }

  return {
    requestId,
    providerId: params.providerId,
    organizationId,
    ownerUserId,
    ownerEntityId: normalizeString(params.binding.ownerEntityId),
    policy: params.binding.policy ?? defaultOAuthSensitiveRequestPolicy(),
    expectedProviderUserId: normalizeString(params.binding.expectedProviderUserId),
    expectedProviderEmail: normalizeEmail(params.binding.expectedProviderEmail),
    expectedProviderUsername: normalizeString(params.binding.expectedProviderUsername),
    allowUnlinkedProviderIdentity: params.binding.allowUnlinkedProviderIdentity === true,
    createdAt: params.now ?? Date.now(),
  };
}

export function buildOAuthConnectedSensitiveRequestEvent(params: {
  binding?: OAuthSensitiveRequestStateBinding;
  providerId: string;
  connectionId: string;
}): SensitiveRequestEvent | undefined {
  if (!params.binding) return undefined;
  return {
    kind: "oauth.connected",
    requestId: params.binding.requestId,
    provider: params.providerId,
    connectionId: params.connectionId,
  };
}

export function redactOAuthSensitiveRequestEvent(
  event: SensitiveRequestEvent,
): SensitiveRequestEvent {
  return redactSensitiveRequestMetadata(event) as SensitiveRequestEvent;
}

function expectedProviderIdentityMatches(params: {
  binding: OAuthSensitiveRequestStateBinding;
  providerIdentity: OAuthCallbackProviderIdentity;
}): SensitiveRequestAuthorizationDecision | null {
  const { binding, providerIdentity } = params;
  const base = {
    actorPolicy: binding.policy.actor,
    actorEntityIds: [],
    organizationId: binding.organizationId,
  };

  if (binding.expectedProviderUserId && binding.expectedProviderUserId !== providerIdentity.id) {
    return {
      ...base,
      allowed: false,
      reason: "OAuth provider account does not match request binding",
    };
  }

  const expectedEmail = normalizeEmail(binding.expectedProviderEmail);
  if (expectedEmail && expectedEmail !== normalizeEmail(providerIdentity.email)) {
    return {
      ...base,
      allowed: false,
      reason: "OAuth provider email does not match request binding",
    };
  }

  if (
    binding.expectedProviderUsername &&
    binding.expectedProviderUsername !== providerIdentity.username
  ) {
    return {
      ...base,
      allowed: false,
      reason: "OAuth provider username does not match request binding",
    };
  }

  if (
    binding.expectedProviderUserId ||
    binding.expectedProviderEmail ||
    binding.expectedProviderUsername
  ) {
    return {
      ...base,
      allowed: true,
      matchedBy: "verified_actor",
      reason: "OAuth provider identity matches request binding",
    };
  }

  return null;
}

export async function authorizeOAuthSensitiveRequestCallback(params: {
  binding?: OAuthSensitiveRequestStateBinding;
  providerId: string;
  organizationId: string;
  userId: string;
  providerIdentity: OAuthCallbackProviderIdentity;
  connectionId?: string;
  identityAdapter?: SensitiveRequestIdentityAuthorizationAdapter;
}): Promise<OAuthSensitiveRequestAuthorizationResult> {
  if (!params.binding) {
    return {
      decision: {
        allowed: true,
        actorPolicy: "owner_or_linked_identity",
        reason: "no sensitive request binding present",
      },
    };
  }

  const binding = params.binding;
  if (binding.providerId !== params.providerId) {
    throw new Error("SENSITIVE_REQUEST_PROVIDER_MISMATCH");
  }
  if (binding.organizationId !== params.organizationId) {
    throw new Error("SENSITIVE_REQUEST_ORGANIZATION_MISMATCH");
  }
  if (binding.ownerUserId && binding.ownerUserId !== params.userId) {
    throw new Error("SENSITIVE_REQUEST_OWNER_USER_MISMATCH");
  }

  const expectedMatch = expectedProviderIdentityMatches({
    binding,
    providerIdentity: params.providerIdentity,
  });
  let decision = expectedMatch;

  if (!decision) {
    decision = await authorizeSensitiveRequestActor({
      actor: {
        kind: "connector_identity",
        platform: params.providerId,
        externalId: params.providerIdentity.id,
        organizationId: params.organizationId,
        verified: true,
        email: params.providerIdentity.email,
        username: params.providerIdentity.username,
      },
      context: {
        policy: binding.policy,
        organizationId: binding.organizationId,
        ownerUserId: binding.ownerUserId,
        ownerEntityId: binding.ownerEntityId,
      },
      adapter: params.identityAdapter ?? createCloudSensitiveRequestAuthorizationAdapter(),
    });
  }

  if (
    !decision.allowed &&
    binding.allowUnlinkedProviderIdentity &&
    binding.ownerUserId === params.userId
  ) {
    decision = {
      allowed: true,
      actorPolicy: binding.policy.actor,
      matchedBy: "verified_actor",
      actorUserId: params.userId,
      organizationId: params.organizationId,
      reason:
        "request explicitly allows the initiating owner to link an unrecognized provider identity",
    };
  }

  const event =
    decision.allowed && params.connectionId
      ? buildOAuthConnectedSensitiveRequestEvent({
          binding,
          providerId: params.providerId,
          connectionId: params.connectionId,
        })
      : undefined;

  return {
    decision,
    event: event ? redactOAuthSensitiveRequestEvent(event) : undefined,
  };
}
