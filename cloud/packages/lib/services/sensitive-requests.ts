import {
  type SensitiveRequest as CoreSensitiveRequest,
  defaultSensitiveRequestPolicy,
  redactSensitiveRequestMetadata,
  type SensitiveRequestCallback,
  type SensitiveRequestDeliveryPlan,
  type SensitiveRequestEvent,
  type SensitiveRequestKind,
  type SensitiveRequestPolicy,
  type SensitiveRequestPrivateInfoTarget,
  type SensitiveRequestSecretTarget,
  type SensitiveRequestStatus,
  type SensitiveRequestTarget,
} from "@elizaos/core";
import {
  type SensitiveRequest as DbSensitiveRequest,
  type SensitiveRequestEvent as DbSensitiveRequestEvent,
  type NewSensitiveRequest,
  type NewSensitiveRequestEvent,
  type SensitiveRequestActorType,
  type SensitiveRequestAuditEventType,
  type SensitiveRequestWithEvents,
  sensitiveRequestsRepository,
} from "@/db/repositories/sensitive-requests";
import {
  ApiError,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import {
  secretsService as defaultSecretsService,
  type SecretMetadata,
  type AuditContext as SecretsAuditContext,
  type SecretsService,
} from "@/lib/services/secrets";

export interface SensitiveRequestActor {
  type?: Extract<SensitiveRequestActorType, "user" | "api_key" | "system">;
  userId?: string;
  organizationId?: string;
  email?: string | null;
  role?: string | null;
  ipAddress?: string;
  userAgent?: string;
}

export interface CreateSensitiveRequestParams {
  kind: Extract<SensitiveRequestKind, "secret" | "private_info">;
  agentId: string;
  organizationId?: string;
  ownerEntityId?: string;
  requesterEntityId?: string;
  sourceRoomId?: string;
  sourceChannelType?: string;
  sourcePlatform?: string;
  target: SensitiveRequestSecretTarget | SensitiveRequestPrivateInfoTarget;
  policy?: Partial<SensitiveRequestPolicy>;
  delivery?: Partial<SensitiveRequestDeliveryPlan>;
  callback?: SensitiveRequestCallback;
  expiresAt?: Date;
  lifetimeSeconds?: number;
}

export interface SubmitSensitiveRequestParams {
  id: string;
  token?: string;
  actor?: SensitiveRequestActor;
  value?: string;
  fields?: Record<string, string>;
}

export interface SensitiveRequestEventView {
  id: string;
  eventType: SensitiveRequestAuditEventType;
  actorType: SensitiveRequestActorType;
  actorId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type SensitiveRequestPublicView = Omit<
  CoreSensitiveRequest,
  | "organizationId"
  | "ownerEntityId"
  | "requesterEntityId"
  | "sourceRoomId"
  | "sourceChannelType"
  | "sourcePlatform"
  | "callback"
  | "fulfilledAt"
  | "audit"
> & {
  organizationId: string | null;
  ownerEntityId: string | null;
  requesterEntityId: string | null;
  sourceRoomId: string | null;
  sourceChannelType: string | null;
  sourcePlatform: string | null;
  callback?: SensitiveRequestCallback;
  fulfilledAt: string | null;
  canceledAt: string | null;
  expiredAt: string | null;
};

export interface SensitiveRequestPrivateView extends SensitiveRequestPublicView {
  audit: SensitiveRequestEventView[];
}

export interface CreateSensitiveRequestResult {
  request: SensitiveRequestPrivateView;
  submitToken: string;
}

export interface SensitiveRequestsRepositoryLike {
  create(data: NewSensitiveRequest): Promise<DbSensitiveRequest>;
  findById(id: string): Promise<DbSensitiveRequest | undefined>;
  findWithEvents(id: string): Promise<SensitiveRequestWithEvents | undefined>;
  update(id: string, data: Partial<NewSensitiveRequest>): Promise<DbSensitiveRequest | undefined>;
  transitionStatus(
    id: string,
    fromStatuses: SensitiveRequestStatus[],
    status: SensitiveRequestStatus,
    data?: Partial<NewSensitiveRequest>,
  ): Promise<DbSensitiveRequest | undefined>;
  markTokenUsed(id: string): Promise<DbSensitiveRequest | undefined>;
  appendEvent(data: NewSensitiveRequestEvent): Promise<DbSensitiveRequestEvent>;
  listEvents(requestId: string): Promise<DbSensitiveRequestEvent[]>;
}

export interface SensitiveRequestsServiceDeps {
  repository?: SensitiveRequestsRepositoryLike;
  secretsService?: Pick<SecretsService, "create">;
  now?: () => Date;
  generateToken?: () => string | Promise<string>;
  fulfillPrivateInfo?: (params: {
    requestId: string;
    organizationId: string | null;
    target: SensitiveRequestPrivateInfoTarget;
    fields: Record<string, string>;
    actor?: SensitiveRequestActor;
  }) => Promise<void>;
  dispatchEvent?: (params: {
    event: SensitiveRequestEvent;
    request: SensitiveRequestPublicView;
  }) => Promise<void>;
}

const DEFAULT_LIFETIME_SECONDS = 30 * 60;
const MAX_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const TOKEN_BYTES = 32;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function defaultGenerateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return `sr_${bytesToBase64Url(bytes)}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizePolicy(
  kind: SensitiveRequestKind,
  policy?: Partial<SensitiveRequestPolicy> | Record<string, unknown>,
): SensitiveRequestPolicy {
  return { ...defaultSensitiveRequestPolicy(kind), ...(policy ?? {}) } as SensitiveRequestPolicy;
}

function sanitizeMetadata(metadata?: Record<string, unknown>): Record<string, unknown> {
  return redactSensitiveRequestMetadata((metadata ?? {}) as never) as Record<string, unknown>;
}

function redactCallback(callback: Record<string, unknown>): SensitiveRequestCallback | undefined {
  const redacted = sanitizeMetadata(callback) as SensitiveRequestCallback;
  if (redacted.http) {
    redacted.http = {
      ...redacted.http,
      url: "[redacted]",
    };
  }
  return Object.keys(redacted).length > 0 ? redacted : undefined;
}

function redactDelivery(delivery: Record<string, unknown>): SensitiveRequestDeliveryPlan {
  return redactSensitiveRequestMetadata(
    delivery as never,
  ) as unknown as SensitiveRequestDeliveryPlan;
}

function isSecretTarget(
  target: SensitiveRequestTarget | Record<string, unknown>,
): target is SensitiveRequestSecretTarget {
  return (
    (target as SensitiveRequestSecretTarget).kind === "secret" &&
    typeof (target as SensitiveRequestSecretTarget).key === "string"
  );
}

function isPrivateInfoTarget(
  target: SensitiveRequestTarget | Record<string, unknown>,
): target is SensitiveRequestPrivateInfoTarget {
  return (
    (target as SensitiveRequestPrivateInfoTarget).kind === "private_info" &&
    Array.isArray((target as SensitiveRequestPrivateInfoTarget).fields)
  );
}

function redactTarget(
  kind: SensitiveRequestKind,
  target: Record<string, unknown>,
): SensitiveRequestTarget {
  if (kind === "secret" && isSecretTarget(target)) {
    return {
      kind: "secret",
      key: target.key,
      scope: target.scope,
      appId: target.appId,
      validation: target.validation,
    };
  }
  if (kind === "private_info" && isPrivateInfoTarget(target)) {
    return {
      kind: "private_info",
      fields: target.fields.map((field) => ({
        name: field.name,
        label: field.label,
        required: field.required ?? false,
        classification: field.classification,
      })),
      storage: target.storage ? { kind: target.storage.kind, key: target.storage.key } : undefined,
    };
  }
  return redactSensitiveRequestMetadata(target as never) as unknown as SensitiveRequestTarget;
}

function actorTypeForAudit(
  actor?: SensitiveRequestActor,
  tokenActor = false,
): SensitiveRequestActorType {
  if (tokenActor) return "token";
  if (actor?.type === "api_key") return "api_key";
  if (actor?.type === "system") return "system";
  return actor ? "user" : "system";
}

function actorIdForAudit(actor?: SensitiveRequestActor, tokenActor = false): string | undefined {
  if (tokenActor) return "single-use-token";
  return actor?.userId;
}

function assertSameOrganization(request: DbSensitiveRequest, actor?: SensitiveRequestActor): void {
  if (!request.organization_id) return;
  if (!actor?.organizationId) throw AuthenticationError("Authentication required");
  if (actor.organizationId !== request.organization_id) {
    throw ForbiddenError("Sensitive request belongs to a different organization");
  }
}

function assertCreatePolicy(kind: SensitiveRequestKind, policy: SensitiveRequestPolicy): void {
  if (kind === "secret") {
    if (policy.allowPublicLink) {
      throw ValidationError("Secret requests cannot allow public links");
    }
    if (!policy.requirePrivateDelivery && !policy.requireAuthenticatedLink) {
      throw ValidationError("Secret requests require private delivery or authenticated links");
    }
  }
  if (kind === "oauth" && !policy.requireAuthenticatedLink) {
    throw ValidationError("OAuth requests require authenticated provider callbacks");
  }
}

function assertCreateTarget(kind: SensitiveRequestKind, target: SensitiveRequestTarget): void {
  if (kind === "secret") {
    if (!isSecretTarget(target) || !target.key.trim()) {
      throw ValidationError("Secret requests require target.key");
    }
    return;
  }

  if (kind === "private_info") {
    if (!isPrivateInfoTarget(target) || target.fields.length === 0) {
      throw ValidationError("Private info requests require at least one field");
    }
    for (const field of target.fields) {
      if (!field.name.trim()) throw ValidationError("Private info field names are required");
    }
  }
}

function safeFulfillmentError(): ApiError {
  return new ApiError(500, "internal_error", "Sensitive request fulfillment failed");
}

export class SensitiveRequestsService {
  private readonly repository: SensitiveRequestsRepositoryLike;
  private readonly secretsService: Pick<SecretsService, "create">;
  private readonly now: () => Date;
  private readonly generateToken: () => string | Promise<string>;
  private readonly fulfillPrivateInfo?: SensitiveRequestsServiceDeps["fulfillPrivateInfo"];
  private readonly dispatchEvent?: SensitiveRequestsServiceDeps["dispatchEvent"];

  constructor(deps: SensitiveRequestsServiceDeps = {}) {
    this.repository = deps.repository ?? sensitiveRequestsRepository;
    this.secretsService = deps.secretsService ?? defaultSecretsService;
    this.now = deps.now ?? (() => new Date());
    this.generateToken = deps.generateToken ?? defaultGenerateToken;
    this.fulfillPrivateInfo = deps.fulfillPrivateInfo;
    this.dispatchEvent = deps.dispatchEvent;
  }

  async create(
    params: CreateSensitiveRequestParams,
    actor: SensitiveRequestActor,
  ): Promise<CreateSensitiveRequestResult> {
    const policy = normalizePolicy(params.kind, params.policy);
    assertCreatePolicy(params.kind, policy);
    assertCreateTarget(params.kind, params.target);

    const expiresAt = this.resolveExpiry(params.expiresAt, params.lifetimeSeconds);
    const submitToken = await this.generateToken();
    const tokenHash = await sha256Hex(submitToken);
    const organizationId = params.organizationId ?? actor.organizationId;
    if (!organizationId) throw ValidationError("Sensitive requests require an organization");

    const request = await this.repository.create({
      kind: params.kind,
      status: "pending",
      organization_id: organizationId,
      agent_id: params.agentId,
      owner_entity_id: params.ownerEntityId,
      requester_entity_id: params.requesterEntityId,
      source_room_id: params.sourceRoomId,
      source_channel_type: params.sourceChannelType,
      source_platform: params.sourcePlatform,
      target: params.target as unknown as Record<string, unknown>,
      policy: policy as unknown as Record<string, unknown>,
      delivery: {
        mode: "cloud_link",
        privateOnly: policy.requirePrivateDelivery,
        tokenRequired: true,
        ...(params.delivery ?? {}),
      },
      callback: (params.callback ?? { type: "none" }) as unknown as Record<string, unknown>,
      token_hash: tokenHash,
      expires_at: expiresAt,
      created_by: actor.userId,
    });

    await this.recordAudit(request, "request.created", actor, {
      kind: request.kind,
      target: redactTarget(request.kind, request.target),
      expiresAt: request.expires_at.toISOString(),
    });

    const withEvents = await this.repository.findWithEvents(request.id);
    return {
      request: this.toPrivateView(withEvents ?? { request, events: [] }),
      submitToken,
    };
  }

  async get(id: string, actor: SensitiveRequestActor): Promise<SensitiveRequestPrivateView> {
    const request = await this.loadOrThrow(id);
    const current = await this.expireIfNeeded(request);
    assertSameOrganization(current, actor);
    await this.recordAudit(current, "request.viewed", actor);
    return this.toPrivateView({
      request: current,
      events: await this.repository.listEvents(current.id),
    });
  }

  async submit(params: SubmitSensitiveRequestParams): Promise<SensitiveRequestPrivateView> {
    const request = await this.expireIfNeeded(await this.loadOrThrow(params.id));
    if (request.status !== "pending") {
      throw new ApiError(409, "session_not_ready", `Sensitive request is ${request.status}`);
    }

    const auth = await this.authorizeSubmit(request, params);
    let tokenMarkedRequest = request;
    if (auth.tokenValid) {
      const marked = await this.repository.markTokenUsed(request.id);
      if (!marked) throw AuthenticationError("Sensitive request token has already been used");
      tokenMarkedRequest = marked;
      await this.recordAudit(marked, "token.used", params.actor, undefined, true);
    }

    await this.recordAudit(
      tokenMarkedRequest,
      "request.submitted",
      params.actor,
      {
        kind: tokenMarkedRequest.kind,
      },
      auth.tokenActor,
    );

    try {
      if (tokenMarkedRequest.kind === "secret") {
        await this.fulfillSecretRequest(tokenMarkedRequest, params);
      } else if (tokenMarkedRequest.kind === "private_info") {
        await this.fulfillPrivateInfoRequest(tokenMarkedRequest, params);
      } else {
        throw ValidationError(`Unsupported sensitive request kind: ${tokenMarkedRequest.kind}`);
      }
    } catch (error) {
      await this.markFailed(tokenMarkedRequest, params.actor, auth.tokenActor);
      if (error instanceof ApiError && error.status < 500) throw error;
      throw safeFulfillmentError();
    }

    const fulfilled = await this.repository.transitionStatus(
      tokenMarkedRequest.id,
      ["pending"],
      "fulfilled",
      { fulfilled_at: this.now() },
    );
    const finalRequest = fulfilled ?? (await this.loadOrThrow(tokenMarkedRequest.id));
    await this.recordAudit(
      finalRequest,
      "request.fulfilled",
      params.actor,
      {
        kind: finalRequest.kind,
      },
      auth.tokenActor,
    );

    return this.toPrivateView({
      request: finalRequest,
      events: await this.repository.listEvents(finalRequest.id),
    });
  }

  async cancel(id: string, actor: SensitiveRequestActor): Promise<SensitiveRequestPrivateView> {
    const request = await this.loadOrThrow(id);
    assertSameOrganization(request, actor);
    if (request.status !== "pending") {
      throw new ApiError(409, "session_not_ready", `Sensitive request is ${request.status}`);
    }
    const canceled = await this.repository.transitionStatus(id, ["pending"], "canceled", {
      canceled_at: this.now(),
    });
    if (!canceled) throw new ApiError(409, "session_not_ready", "Sensitive request is not pending");
    await this.recordAudit(canceled, "request.canceled", actor);
    await this.emit({ kind: "request.canceled", requestId: canceled.id }, canceled);
    return this.toPrivateView({
      request: canceled,
      events: await this.repository.listEvents(canceled.id),
    });
  }

  async expire(id: string, actor?: SensitiveRequestActor): Promise<SensitiveRequestPrivateView> {
    const request = await this.loadOrThrow(id);
    if (actor) assertSameOrganization(request, actor);
    const expired = await this.expireRequest(request, actor);
    return this.toPrivateView({
      request: expired,
      events: await this.repository.listEvents(expired.id),
    });
  }

  toPublicView(request: DbSensitiveRequest): SensitiveRequestPublicView {
    return {
      id: request.id,
      kind: request.kind,
      status: request.status,
      agentId: request.agent_id,
      organizationId: request.organization_id,
      ownerEntityId: request.owner_entity_id,
      requesterEntityId: request.requester_entity_id,
      sourceRoomId: request.source_room_id,
      sourceChannelType: request.source_channel_type,
      sourcePlatform: request.source_platform,
      target: redactTarget(request.kind, request.target),
      policy: normalizePolicy(request.kind, request.policy),
      delivery: redactDelivery(request.delivery),
      callback: redactCallback(request.callback),
      expiresAt: request.expires_at.toISOString(),
      fulfilledAt: toIso(request.fulfilled_at),
      canceledAt: toIso(request.canceled_at),
      expiredAt: toIso(request.expired_at),
      createdAt: request.created_at.toISOString(),
      updatedAt: request.updated_at.toISOString(),
    };
  }

  private toPrivateView(withEvents: SensitiveRequestWithEvents): SensitiveRequestPrivateView {
    return {
      ...this.toPublicView(withEvents.request),
      audit: withEvents.events.map((event) => ({
        id: event.id,
        eventType: event.event_type,
        actorType: event.actor_type,
        actorId: event.actor_id,
        metadata: sanitizeMetadata(event.metadata),
        createdAt: event.created_at.toISOString(),
      })),
    };
  }

  private resolveExpiry(expiresAt?: Date, lifetimeSeconds?: number): Date {
    const now = this.now();
    const resolvedLifetime = Math.min(
      Math.max(lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS, 60),
      MAX_LIFETIME_SECONDS,
    );
    const resolved = expiresAt ?? new Date(now.getTime() + resolvedLifetime * 1000);
    if (resolved <= now) throw ValidationError("Sensitive request expiry must be in the future");
    return resolved;
  }

  private async loadOrThrow(id: string): Promise<DbSensitiveRequest> {
    const request = await this.repository.findById(id);
    if (!request) throw NotFoundError("Sensitive request not found");
    return request;
  }

  private async expireIfNeeded(request: DbSensitiveRequest): Promise<DbSensitiveRequest> {
    if (request.status !== "pending") return request;
    if (request.expires_at > this.now()) return request;
    return this.expireRequest(request);
  }

  private async expireRequest(
    request: DbSensitiveRequest,
    actor?: SensitiveRequestActor,
  ): Promise<DbSensitiveRequest> {
    if (request.status !== "pending") return request;
    const expired = await this.repository.transitionStatus(request.id, ["pending"], "expired", {
      expired_at: this.now(),
    });
    const finalRequest = expired ?? (await this.loadOrThrow(request.id));
    await this.recordAudit(finalRequest, "request.expired", actor);
    await this.emit({ kind: "request.expired", requestId: finalRequest.id }, finalRequest);
    return finalRequest;
  }

  private async authorizeSubmit(
    request: DbSensitiveRequest,
    params: SubmitSensitiveRequestParams,
  ): Promise<{ tokenValid: boolean; tokenActor: boolean }> {
    const policy = normalizePolicy(request.kind, request.policy);
    let tokenValid = false;

    if (params.token) {
      const tokenHash = await sha256Hex(params.token);
      tokenValid = request.token_hash === tokenHash && !request.token_used_at;
      if (!tokenValid) throw AuthenticationError("Invalid or expired sensitive request token");
    }

    if (policy.requireAuthenticatedLink) {
      assertSameOrganization(request, params.actor);
      return { tokenValid, tokenActor: false };
    }

    if (!params.actor) {
      if (!tokenValid) throw AuthenticationError("A valid sensitive request token is required");
      if (request.kind === "secret" && policy.allowPublicLink) {
        throw ForbiddenError(
          "Secret requests cannot be submitted from public unauthenticated links",
        );
      }
      return { tokenValid, tokenActor: true };
    }

    assertSameOrganization(request, params.actor);
    return { tokenValid, tokenActor: false };
  }

  private async fulfillSecretRequest(
    request: DbSensitiveRequest,
    params: SubmitSensitiveRequestParams,
  ): Promise<SecretMetadata> {
    if (typeof params.value !== "string" || params.value.length === 0) {
      throw ValidationError("Secret submissions require value");
    }
    if (!request.organization_id) throw ValidationError("Secret request requires organization");
    if (!isSecretTarget(request.target)) throw ValidationError("Invalid secret target");

    const target = request.target;
    const createdBy = params.actor?.userId ?? request.created_by;
    if (!createdBy) throw AuthenticationError("Secret fulfillment requires an authenticated owner");

    const secret = await this.secretsService.create(
      {
        organizationId: request.organization_id,
        name: target.key,
        value: params.value,
        scope: "organization",
        description:
          target.scope && target.scope !== "global"
            ? `Collected by sensitive request ${request.id} for ${target.scope} scope`
            : `Collected by sensitive request ${request.id}`,
        createdBy,
      },
      this.toSecretsAuditContext(request, params.actor),
    );

    await this.recordAudit(request, "secret.set", params.actor, {
      key: target.key,
      scope: target.scope ?? "organization",
      secretId: secret.id,
    });
    await this.emit(
      {
        kind: "secret.set",
        requestId: request.id,
        key: target.key,
        scope: target.scope ?? "organization",
      },
      request,
    );
    return secret;
  }

  private async fulfillPrivateInfoRequest(
    request: DbSensitiveRequest,
    params: SubmitSensitiveRequestParams,
  ): Promise<void> {
    if (!params.fields || typeof params.fields !== "object") {
      throw ValidationError("Private info submissions require fields");
    }
    if (!isPrivateInfoTarget(request.target)) throw ValidationError("Invalid private info target");

    const allowedFields = new Set(request.target.fields.map((field) => field.name));
    const submittedFieldNames = Object.keys(params.fields).filter((name) =>
      allowedFields.has(name),
    );
    if (submittedFieldNames.length === 0) {
      throw ValidationError("Private info submission did not include requested fields");
    }

    const missingRequired = request.target.fields
      .filter((field) => field.required && !params.fields?.[field.name])
      .map((field) => field.name);
    if (missingRequired.length > 0) {
      throw ValidationError("Private info submission is missing required fields", {
        missingFields: missingRequired,
      });
    }

    await this.fulfillPrivateInfo?.({
      requestId: request.id,
      organizationId: request.organization_id,
      target: request.target,
      fields: Object.fromEntries(
        submittedFieldNames.map((name) => [name, params.fields?.[name] ?? ""]),
      ),
      actor: params.actor,
    });

    await this.recordAudit(request, "private_info.submitted", params.actor, {
      fields: submittedFieldNames,
    });
    await this.emit(
      { kind: "private_info.submitted", requestId: request.id, fields: submittedFieldNames },
      request,
    );
  }

  private toSecretsAuditContext(
    request: DbSensitiveRequest,
    actor?: SensitiveRequestActor,
  ): SecretsAuditContext {
    return {
      actorType:
        actor?.type === "api_key" ? "api_key" : actor?.type === "system" ? "system" : "user",
      actorId: actor?.userId ?? request.created_by ?? "sensitive-request",
      actorEmail: actor?.email ?? undefined,
      ipAddress: actor?.ipAddress,
      userAgent: actor?.userAgent,
      source: "sensitive_request",
      requestId: request.id,
      endpoint: "sensitive-requests.submit",
    };
  }

  private async markFailed(
    request: DbSensitiveRequest,
    actor?: SensitiveRequestActor,
    tokenActor = false,
  ): Promise<void> {
    const failed =
      request.status === "pending"
        ? await this.repository.transitionStatus(request.id, ["pending"], "failed")
        : request;
    await this.recordAudit(
      failed ?? request,
      "request.failed",
      actor,
      {
        reason: "fulfillment_failed",
      },
      tokenActor,
    );
  }

  private async recordAudit(
    request: DbSensitiveRequest,
    eventType: SensitiveRequestAuditEventType,
    actor?: SensitiveRequestActor,
    metadata?: Record<string, unknown>,
    tokenActor = false,
  ): Promise<void> {
    await this.repository.appendEvent({
      request_id: request.id,
      organization_id: request.organization_id,
      event_type: eventType,
      actor_type: actorTypeForAudit(actor, tokenActor),
      actor_id: actorIdForAudit(actor, tokenActor),
      metadata: sanitizeMetadata(metadata),
    });
  }

  private async emit(event: SensitiveRequestEvent, request: DbSensitiveRequest): Promise<void> {
    if (!this.dispatchEvent) return;
    await this.dispatchEvent({
      event,
      request: this.toPublicView(request),
    });
  }
}

export const sensitiveRequestsService = new SensitiveRequestsService();
