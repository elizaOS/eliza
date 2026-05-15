import type { OAuthIntentRow, OAuthIntentsRepository } from "../../db/repositories/oauth-intents";
import { logger } from "../utils/logger";

export type { OAuthIntentRow } from "../../db/repositories/oauth-intents";

export type OAuthIntentProvider = OAuthIntentRow["provider"];
export type OAuthIntentStatus = OAuthIntentRow["status"];

const DEFAULT_EXPIRES_IN_MS = 15 * 60 * 1000; // 15 minutes
const TERMINAL_STATUSES: ReadonlySet<OAuthIntentStatus> = new Set([
  "bound",
  "denied",
  "expired",
  "canceled",
]);

const SUPPORTED_PROVIDERS: ReadonlyArray<OAuthIntentProvider> = [
  "google",
  "discord",
  "linkedin",
  "linear",
  "shopify",
  "calendly",
];

export interface CreateOAuthIntentInput {
  organizationId: string;
  agentId?: string | null;
  provider: OAuthIntentProvider;
  scopes: string[];
  expectedIdentityId?: string;
  stateTokenHash: string;
  pkceVerifierHash?: string;
  hostedUrl?: string;
  callbackUrl?: string;
  expiresInMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ListOAuthIntentsFilter {
  status?: OAuthIntentStatus;
  agentId?: string;
  provider?: OAuthIntentProvider;
  limit?: number;
  offset?: number;
}

export interface OAuthIntentsService {
  create(input: CreateOAuthIntentInput): Promise<OAuthIntentRow>;
  get(id: string, organizationId: string): Promise<OAuthIntentRow | null>;
  getByStateTokenHash(stateTokenHash: string): Promise<OAuthIntentRow | null>;
  list(organizationId: string, filter?: ListOAuthIntentsFilter): Promise<OAuthIntentRow[]>;
  markBound(
    id: string,
    details: { connectorIdentityId?: string; scopesGranted?: string[] },
  ): Promise<OAuthIntentRow>;
  markDenied(id: string, reason?: string): Promise<OAuthIntentRow>;
  cancel(id: string, organizationId: string, reason?: string): Promise<OAuthIntentRow>;
  expirePast(now?: Date): Promise<string[]>;
}

interface OAuthIntentsServiceDeps {
  repository: OAuthIntentsRepository;
}

function validateCreateInput(input: CreateOAuthIntentInput): void {
  if (!input.organizationId) {
    throw new Error("organizationId is required");
  }
  if (!SUPPORTED_PROVIDERS.includes(input.provider)) {
    throw new Error(`Unsupported provider: ${input.provider}`);
  }
  if (!Array.isArray(input.scopes)) {
    throw new Error("scopes must be an array");
  }
  if (!input.stateTokenHash || input.stateTokenHash.length < 16) {
    throw new Error("stateTokenHash must be a hashed state token");
  }
  if (input.expiresInMs !== undefined && input.expiresInMs <= 0) {
    throw new Error("expiresInMs must be positive");
  }
}

function redactIntentPayload(args: {
  intent: OAuthIntentRow;
  status: OAuthIntentStatus;
  reason?: string;
  connectorIdentityId?: string;
  scopesGranted?: string[];
}): Record<string, unknown> {
  return {
    oauthIntentId: args.intent.id,
    organizationId: args.intent.organizationId,
    provider: args.intent.provider,
    status: args.status,
    scopes: args.intent.scopes,
    connectorIdentityId: args.connectorIdentityId,
    scopesGranted: args.scopesGranted,
    reason: args.reason,
  };
}

function assertNotTerminal(row: OAuthIntentRow, action: string): void {
  if (TERMINAL_STATUSES.has(row.status)) {
    throw new Error(
      `Cannot ${action} oauth intent ${row.id}: already in terminal status "${row.status}"`,
    );
  }
}

function assertCancelable(row: OAuthIntentRow): void {
  if (row.status !== "pending") {
    throw new Error(
      `Cannot cancel oauth intent ${row.id}: status "${row.status}" is not cancelable`,
    );
  }
}

function requireRow(
  row: OAuthIntentRow | null | undefined,
  id: string,
  context: string,
): OAuthIntentRow {
  if (!row) {
    throw new Error(`OAuth intent ${id} not found (${context})`);
  }
  return row;
}

class OAuthIntentsServiceImpl implements OAuthIntentsService {
  private readonly repository: OAuthIntentsRepository;

  constructor(deps: OAuthIntentsServiceDeps) {
    this.repository = deps.repository;
  }

  async create(input: CreateOAuthIntentInput): Promise<OAuthIntentRow> {
    validateCreateInput(input);

    const expiresInMs = input.expiresInMs ?? DEFAULT_EXPIRES_IN_MS;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresInMs);

    const created = await this.repository.createOAuthIntent({
      organizationId: input.organizationId,
      agentId: input.agentId ?? null,
      provider: input.provider,
      scopes: input.scopes,
      expectedIdentityId: input.expectedIdentityId ?? null,
      stateTokenHash: input.stateTokenHash,
      pkceVerifierHash: input.pkceVerifierHash ?? null,
      hostedUrl: input.hostedUrl ?? null,
      callbackUrl: input.callbackUrl ?? null,
      expiresAt,
      metadata: input.metadata ?? {},
    });

    await this.repository.recordOAuthIntentEvent({
      oauthIntentId: created.id,
      eventName: "oauth.created",
      redactedPayload: redactIntentPayload({ intent: created, status: created.status }),
    });

    logger.info("[OAuthIntents] Created oauth intent", {
      oauthIntentId: created.id,
      organizationId: created.organizationId,
      provider: created.provider,
      scopeCount: created.scopes.length,
    });

    return created;
  }

  async get(id: string, organizationId: string): Promise<OAuthIntentRow | null> {
    const row = await this.repository.getOAuthIntent(id);
    if (!row || row.organizationId !== organizationId) return null;
    return row;
  }

  async getByStateTokenHash(stateTokenHash: string): Promise<OAuthIntentRow | null> {
    return this.repository.findByStateTokenHash(stateTokenHash);
  }

  async list(
    organizationId: string,
    filter: ListOAuthIntentsFilter = {},
  ): Promise<OAuthIntentRow[]> {
    return this.repository.listOAuthIntents({
      organizationId,
      status: filter.status,
      agentId: filter.agentId,
      provider: filter.provider,
      limit: filter.limit,
      offset: filter.offset,
    });
  }

  async markBound(
    id: string,
    details: { connectorIdentityId?: string; scopesGranted?: string[] },
  ): Promise<OAuthIntentRow> {
    const existing = requireRow(await this.repository.getOAuthIntent(id), id, "markBound lookup");
    if (existing.status === "bound") {
      return existing;
    }
    assertNotTerminal(existing, "bind");

    const updated = requireRow(
      await this.repository.updateOAuthIntentStatus(id, "bound"),
      id,
      "markBound update",
    );

    await this.repository.recordOAuthIntentEvent({
      oauthIntentId: id,
      eventName: "oauth.bound",
      redactedPayload: redactIntentPayload({
        intent: updated,
        status: "bound",
        connectorIdentityId: details.connectorIdentityId,
        scopesGranted: details.scopesGranted,
      }),
    });

    logger.info("[OAuthIntents] Bound oauth intent", {
      oauthIntentId: id,
      provider: updated.provider,
      connectorIdentityId: details.connectorIdentityId,
    });

    return updated;
  }

  async markDenied(id: string, reason?: string): Promise<OAuthIntentRow> {
    const existing = requireRow(await this.repository.getOAuthIntent(id), id, "markDenied lookup");
    if (existing.status === "denied") {
      return existing;
    }
    assertNotTerminal(existing, "deny");

    const updated = requireRow(
      await this.repository.updateOAuthIntentStatus(id, "denied"),
      id,
      "markDenied update",
    );

    await this.repository.recordOAuthIntentEvent({
      oauthIntentId: id,
      eventName: "oauth.denied",
      redactedPayload: redactIntentPayload({ intent: updated, status: "denied", reason }),
    });

    logger.warn("[OAuthIntents] Denied oauth intent", {
      oauthIntentId: id,
      provider: updated.provider,
      reason,
    });

    return updated;
  }

  async cancel(id: string, organizationId: string, reason?: string): Promise<OAuthIntentRow> {
    const existing = requireRow(await this.repository.getOAuthIntent(id), id, "cancel lookup");
    if (existing.organizationId !== organizationId) {
      throw new Error(`OAuth intent ${id} does not belong to organization ${organizationId}`);
    }
    assertCancelable(existing);

    const updated = requireRow(
      await this.repository.updateOAuthIntentStatus(id, "canceled"),
      id,
      "cancel update",
    );

    await this.repository.recordOAuthIntentEvent({
      oauthIntentId: id,
      eventName: "oauth.canceled",
      redactedPayload: redactIntentPayload({ intent: updated, status: "canceled", reason }),
    });

    logger.info("[OAuthIntents] Canceled oauth intent", {
      oauthIntentId: id,
      organizationId,
      reason,
    });

    return updated;
  }

  async expirePast(now: Date = new Date()): Promise<string[]> {
    const expiredIds = await this.repository.expirePastOAuthIntents(now);
    for (const id of expiredIds) {
      const row = await this.repository.getOAuthIntent(id);
      if (!row) continue;
      await this.repository.recordOAuthIntentEvent({
        oauthIntentId: id,
        eventName: "oauth.expired",
        redactedPayload: redactIntentPayload({ intent: row, status: "expired" }),
      });
    }
    if (expiredIds.length > 0) {
      logger.info("[OAuthIntents] Expired oauth intents", { count: expiredIds.length });
    }
    return expiredIds;
  }
}

export function createOAuthIntentsService(deps: OAuthIntentsServiceDeps): OAuthIntentsService {
  return new OAuthIntentsServiceImpl(deps);
}

export function redactOAuthIntentForPublic(
  row: OAuthIntentRow,
): Omit<OAuthIntentRow, "stateTokenHash" | "pkceVerifierHash"> {
  const { stateTokenHash: _state, pkceVerifierHash: _pkce, ...publicRow } = row;
  return publicRow;
}
