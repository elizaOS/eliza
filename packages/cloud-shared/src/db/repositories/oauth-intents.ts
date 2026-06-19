import { and, desc, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { dbWrite as db } from "../client";
import {
  type NewOAuthIntent as NewOAuthIntentDbRow,
  type NewOAuthIntentEvent as NewOAuthIntentEventDbRow,
  type OAuthIntentRow as OAuthIntentDbRow,
  type OAuthIntentEventRow as OAuthIntentEventDbRow,
  type OAuthIntentEventName,
  type OAuthIntentProvider,
  type OAuthIntentStatus,
  oauthIntentEvents,
  oauthIntents,
} from "../schemas/oauth-intents";

export interface ListOAuthIntentsFilter {
  organizationId: string;
  status?: OAuthIntentStatus;
  agentId?: string;
  provider?: OAuthIntentProvider;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

export interface OAuthIntentRow {
  id: string;
  organizationId: string;
  agentId: string | null;
  provider: OAuthIntentProvider;
  scopes: string[];
  expectedIdentityId: string | null;
  status: OAuthIntentStatus;
  stateTokenHash: string;
  pkceVerifierHash: string | null;
  hostedUrl: string | null;
  callbackUrl: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

export interface NewOAuthIntent {
  organizationId: string;
  agentId?: string | null;
  provider: OAuthIntentProvider;
  scopes: string[];
  expectedIdentityId?: string | null;
  status?: OAuthIntentStatus;
  stateTokenHash: string;
  pkceVerifierHash?: string | null;
  hostedUrl?: string | null;
  callbackUrl?: string | null;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
}

export interface NewOAuthIntentEvent {
  oauthIntentId: string;
  eventName: OAuthIntentEventName;
  redactedPayload?: Record<string, unknown>;
}

export type OAuthIntentEventRow = OAuthIntentEventDbRow;

function toDbInsert(input: NewOAuthIntent): NewOAuthIntentDbRow {
  return {
    organization_id: input.organizationId,
    agent_id: input.agentId ?? null,
    provider: input.provider,
    scopes: input.scopes,
    expected_identity_id: input.expectedIdentityId ?? null,
    status: input.status ?? "pending",
    state_token_hash: input.stateTokenHash,
    pkce_verifier_hash: input.pkceVerifierHash ?? null,
    hosted_url: input.hostedUrl ?? null,
    callback_url: input.callbackUrl ?? null,
    expires_at: input.expiresAt,
    metadata: input.metadata ?? {},
  };
}

function toDbPatch(input: Partial<NewOAuthIntent>): Partial<NewOAuthIntentDbRow> {
  const patch: Partial<NewOAuthIntentDbRow> = {};
  if (input.organizationId !== undefined) patch.organization_id = input.organizationId;
  if (input.agentId !== undefined) patch.agent_id = input.agentId;
  if (input.provider !== undefined) patch.provider = input.provider;
  if (input.scopes !== undefined) patch.scopes = input.scopes;
  if (input.expectedIdentityId !== undefined) patch.expected_identity_id = input.expectedIdentityId;
  if (input.status !== undefined) patch.status = input.status;
  if (input.stateTokenHash !== undefined) patch.state_token_hash = input.stateTokenHash;
  if (input.pkceVerifierHash !== undefined) patch.pkce_verifier_hash = input.pkceVerifierHash;
  if (input.hostedUrl !== undefined) patch.hosted_url = input.hostedUrl;
  if (input.callbackUrl !== undefined) patch.callback_url = input.callbackUrl;
  if (input.expiresAt !== undefined) patch.expires_at = input.expiresAt;
  if (input.metadata !== undefined) patch.metadata = input.metadata;
  return patch;
}

function toDomain(row: OAuthIntentDbRow): OAuthIntentRow {
  return {
    id: row.id,
    organizationId: row.organization_id,
    agentId: row.agent_id,
    provider: row.provider,
    scopes: row.scopes,
    expectedIdentityId: row.expected_identity_id,
    status: row.status,
    stateTokenHash: row.state_token_hash,
    pkceVerifierHash: row.pkce_verifier_hash,
    hostedUrl: row.hosted_url,
    callbackUrl: row.callback_url,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: row.metadata,
  };
}

function toDbEvent(input: NewOAuthIntentEvent): NewOAuthIntentEventDbRow {
  return {
    oauth_intent_id: input.oauthIntentId,
    event_name: input.eventName,
    redacted_payload: input.redactedPayload ?? {},
  };
}

export class OAuthIntentsRepository {
  async createOAuthIntent(input: NewOAuthIntent): Promise<OAuthIntentRow> {
    const [row] = await db.insert(oauthIntents).values(toDbInsert(input)).returning();
    return toDomain(row);
  }

  async getOAuthIntent(id: string): Promise<OAuthIntentRow | null> {
    const [row] = await db.select().from(oauthIntents).where(eq(oauthIntents.id, id)).limit(1);
    return row ? toDomain(row) : null;
  }

  async findByStateTokenHash(stateTokenHash: string): Promise<OAuthIntentRow | null> {
    const [row] = await db
      .select()
      .from(oauthIntents)
      .where(eq(oauthIntents.state_token_hash, stateTokenHash))
      .limit(1);
    return row ? toDomain(row) : null;
  }

  async listOAuthIntents(filter: ListOAuthIntentsFilter): Promise<OAuthIntentRow[]> {
    const conditions = [eq(oauthIntents.organization_id, filter.organizationId)];
    if (filter.status) conditions.push(eq(oauthIntents.status, filter.status));
    if (filter.agentId) conditions.push(eq(oauthIntents.agent_id, filter.agentId));
    if (filter.provider) conditions.push(eq(oauthIntents.provider, filter.provider));
    if (filter.since) conditions.push(gte(oauthIntents.created_at, filter.since));
    if (filter.until) conditions.push(lte(oauthIntents.created_at, filter.until));

    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;

    const rows = await db
      .select()
      .from(oauthIntents)
      .where(and(...conditions))
      .orderBy(desc(oauthIntents.created_at))
      .limit(limit)
      .offset(offset);
    return rows.map(toDomain);
  }

  async updateOAuthIntentStatus(
    id: string,
    status: OAuthIntentStatus | null,
    patch: Partial<NewOAuthIntent> = {},
  ): Promise<OAuthIntentRow | null> {
    const dbPatch = toDbPatch(patch);
    const [row] = await db
      .update(oauthIntents)
      .set({ ...dbPatch, ...(status ? { status } : {}), updated_at: new Date() })
      .where(eq(oauthIntents.id, id))
      .returning();
    return row ? toDomain(row) : null;
  }

  async recordOAuthIntentEvent(input: NewOAuthIntentEvent): Promise<OAuthIntentEventRow> {
    const [row] = await db.insert(oauthIntentEvents).values(toDbEvent(input)).returning();
    return row;
  }

  async expirePastOAuthIntents(now: Date): Promise<string[]> {
    const expirable: OAuthIntentStatus[] = ["pending"];
    const rows = await db
      .update(oauthIntents)
      .set({ status: "expired", updated_at: now })
      .where(and(inArray(oauthIntents.status, expirable), lt(oauthIntents.expires_at, now)))
      .returning({ id: oauthIntents.id });
    return rows.map((r) => r.id);
  }
}

export const oauthIntentsRepository = new OAuthIntentsRepository();

export type { OAuthIntentEventName, OAuthIntentProvider, OAuthIntentStatus };
