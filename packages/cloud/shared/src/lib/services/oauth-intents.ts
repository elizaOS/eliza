import { ElizaError } from "@elizaos/core";
// Coordinates cloud service oauth intents behavior behind route handlers.
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
    throw new ElizaError("organizationId is required", {
      code: "AUTHORIZATION_INTENT_INVALID_STATE",
      severity: "ephemeral",
    });
  }
  if (!SUPPORTED_PROVIDERS.includes(input.provider)) {
    throw new ElizaError(`Unsupported provider: ${input.provider}`, {
      code: "AUTHORIZATION_INTENT_INVALID_STATE",
      severity: "ephemeral",
    });
  }
  if (!Array.isArray(input.scopes)) {
    throw new ElizaError("scopes must be an array", {
      code: "AUTHORIZATION_INTENT_INVALID_STATE",
      severity: "ephemeral",
    });
  }
  if (!input.stateTokenHash || input.stateTokenHash.length < 16) {
    throw new ElizaError("stateTokenHash must be a hashed state token", {
      code: "AUTHORIZATION_INTENT_INVALID_STATE",
      severity: "ephemeral",
    });
  }
  if (input.expiresInMs !== undefined && input.expiresInMs <= 0) {
    throw new ElizaError("expiresInMs must be positive", {
      code: "AUTHORIZATION_INTENT_INVALID_STATE",
      severity: "ephemeral",
    });
  }
}

function assertNotTerminal(row: OAuthIntentRow, action: string): void {
  if (TERMINAL_STATUSES.has(row.status)) {
    throw new ElizaError(
      `Cannot ${action} oauth intent ${row.id}: already in terminal status "${row.status}"`,
      { code: "AUTHORIZATION_INTENT_INVALID_STATE", severity: "ephemeral" },
    );
  }
}

function assertCancelable(row: OAuthIntentRow): void {
  if (row.status !== "pending") {
    throw new ElizaError(
      `Cannot cancel oauth intent ${row.id}: status "${row.status}" is not cancelable`,
      { code: "AUTHORIZATION_INTENT_INVALID_STATE", severity: "ephemeral" },
    );
  }
}

function requireRow(
  row: OAuthIntentRow | null | undefined,
  id: string,
  context: string,
): OAuthIntentRow {
  if (!row) {
    throw new ElizaError(`OAuth intent ${id} not found (${context})`, {
      code: "AUTHORIZATION_INTENT_INVALID_STATE",
      severity: "ephemeral",
    });
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
      await this.repository.transitionOAuthIntent(id, "bound", {
        eventPayload: {
          connectorIdentityId: details.connectorIdentityId,
          scopesGranted: details.scopesGranted,
        },
      }),
      id,
      "markBound update",
    );

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
      await this.repository.transitionOAuthIntent(id, "denied", { eventPayload: { reason } }),
      id,
      "markDenied update",
    );

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
      throw new ElizaError(`OAuth intent ${id} does not belong to organization ${organizationId}`, {
        code: "AUTHORIZATION_INTENT_INVALID_STATE",
        severity: "ephemeral",
      });
    }
    assertCancelable(existing);

    const updated = requireRow(
      await this.repository.transitionOAuthIntent(id, "canceled", {
        organizationId,
        eventPayload: { reason },
      }),
      id,
      "cancel update",
    );

    logger.info("[OAuthIntents] Canceled oauth intent", {
      oauthIntentId: id,
      organizationId,
      reason,
    });

    return updated;
  }

  async expirePast(now: Date = new Date()): Promise<string[]> {
    const expiredIds = await this.repository.expirePastOAuthIntents(now);
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
