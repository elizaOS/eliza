import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { dbWrite as db } from "@/db/client";
import {
  type AppSecretRequirement,
  appSecretRequirements,
  type NewAppSecretRequirement,
  type NewOAuthSession,
  type NewSecret,
  type NewSecretAuditLog,
  type NewSecretBinding,
  type OAuthSession,
  oauthSessions,
  type Secret,
  type SecretAuditLog,
  type SecretBinding,
  type SecretEnvironment,
  type SecretProjectType,
  type SecretProvider,
  type SecretScope,
  secretAuditLog,
  secretBindings,
  secrets,
} from "@/db/schemas/secrets";

export interface FindSecretsParams {
  organizationId: string;
  projectId?: string;
  projectType?: SecretProjectType;
  environment?: SecretEnvironment;
  scope?: SecretScope;
  provider?: SecretProvider;
  names?: string[];
  includeBindings?: boolean;
}

class SecretsRepository {
  async create(data: NewSecret): Promise<Secret> {
    const [secret] = await db.insert(secrets).values(data).returning();
    return secret;
  }

  async findById(id: string): Promise<Secret | undefined> {
    const [secret] = await db.select().from(secrets).where(eq(secrets.id, id));
    return secret;
  }

  async findByName(
    organizationId: string,
    name: string,
    projectId?: string,
    environment?: SecretEnvironment,
  ): Promise<Secret | undefined> {
    const conditions = [eq(secrets.organization_id, organizationId), eq(secrets.name, name)];

    if (projectId) {
      conditions.push(eq(secrets.project_id, projectId));
    } else {
      conditions.push(isNull(secrets.project_id));
    }

    if (environment) {
      conditions.push(eq(secrets.environment, environment));
    } else {
      conditions.push(isNull(secrets.environment));
    }

    const results = await db
      .select()
      .from(secrets)
      .where(and(...conditions))
      .limit(1);

    return results[0];
  }

  async findByContext(params: FindSecretsParams): Promise<Secret[]> {
    const {
      organizationId,
      projectId,
      projectType,
      environment,
      scope,
      provider,
      names,
      includeBindings,
    } = params;

    const conditions = [eq(secrets.organization_id, organizationId)];

    if (scope) {
      conditions.push(eq(secrets.scope, scope));
    }

    if (provider) {
      conditions.push(eq(secrets.provider, provider));
    }

    if (projectId && includeBindings) {
      const boundSecretIds = db
        .select({ id: secretBindings.secret_id })
        .from(secretBindings)
        .where(
          and(
            eq(secretBindings.project_id, projectId),
            projectType ? eq(secretBindings.project_type, projectType) : sql`1=1`,
          ),
        );

      conditions.push(
        or(
          eq(secrets.project_id, projectId),
          isNull(secrets.project_id),
          inArray(secrets.id, boundSecretIds),
        )!,
      );
    } else if (projectId) {
      conditions.push(sql`(${secrets.project_id} = ${projectId} OR ${secrets.project_id} IS NULL)`);
    } else {
      conditions.push(isNull(secrets.project_id));
    }

    if (projectType && !includeBindings) {
      conditions.push(or(eq(secrets.project_type, projectType), isNull(secrets.project_type))!);
    }

    if (environment) {
      conditions.push(
        sql`(${secrets.environment} = ${environment} OR ${secrets.environment} IS NULL)`,
      );
    } else {
      conditions.push(isNull(secrets.environment));
    }

    if (names && names.length > 0) {
      conditions.push(inArray(secrets.name, names));
    }

    const results = await db
      .select()
      .from(secrets)
      .where(and(...conditions))
      .orderBy(
        sql`CASE WHEN ${secrets.project_id} IS NOT NULL THEN 0 ELSE 1 END`,
        sql`CASE WHEN ${secrets.environment} IS NOT NULL THEN 0 ELSE 1 END`,
        secrets.name,
      );

    const seen = new Set<string>();
    return results.filter((secret) => {
      if (seen.has(secret.name)) return false;
      seen.add(secret.name);
      return true;
    });
  }

  async listFiltered(params: {
    organizationId: string;
    projectId?: string;
    projectType?: SecretProjectType;
    environment?: SecretEnvironment;
    provider?: SecretProvider;
    limit?: number;
    offset?: number;
  }): Promise<{ secrets: Secret[]; total: number }> {
    const {
      organizationId,
      projectId,
      projectType,
      environment,
      provider,
      limit = 100,
      offset = 0,
    } = params;

    const conditions = [eq(secrets.organization_id, organizationId)];

    if (projectId) {
      conditions.push(eq(secrets.project_id, projectId));
    }

    if (projectType) {
      conditions.push(eq(secrets.project_type, projectType));
    }

    if (environment) {
      conditions.push(eq(secrets.environment, environment));
    }

    if (provider) {
      conditions.push(eq(secrets.provider, provider));
    }

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(secrets)
      .where(and(...conditions));

    const results = await db
      .select()
      .from(secrets)
      .where(and(...conditions))
      .orderBy(secrets.name)
      .limit(limit)
      .offset(offset);

    return { secrets: results, total: countResult?.count ?? 0 };
  }

  async listByOrganization(organizationId: string): Promise<Secret[]> {
    return db
      .select()
      .from(secrets)
      .where(eq(secrets.organization_id, organizationId))
      .orderBy(secrets.name);
  }

  async listByProject(projectId: string): Promise<Secret[]> {
    return db.select().from(secrets).where(eq(secrets.project_id, projectId)).orderBy(secrets.name);
  }

  async update(id: string, data: Partial<NewSecret>): Promise<Secret | undefined> {
    const [secret] = await db
      .update(secrets)
      .set({ ...data, updated_at: new Date() })
      .where(eq(secrets.id, id))
      .returning();
    return secret;
  }

  async delete(id: string): Promise<boolean> {
    const result = await db.delete(secrets).where(eq(secrets.id, id)).returning({ id: secrets.id });
    return result.length > 0;
  }

  async recordAccess(id: string): Promise<void> {
    await db
      .update(secrets)
      .set({
        access_count: sql`${secrets.access_count} + 1`,
        last_accessed_at: new Date(),
      })
      .where(eq(secrets.id, id));
  }

  async findExpiringSoon(withinDays: number): Promise<Secret[]> {
    const now = new Date();
    const deadline = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);

    return db
      .select()
      .from(secrets)
      .where(and(gte(secrets.expires_at, now), lte(secrets.expires_at, deadline)))
      .orderBy(secrets.expires_at);
  }
}

class OAuthSessionsRepository {
  async create(data: NewOAuthSession): Promise<OAuthSession> {
    const [session] = await db.insert(oauthSessions).values(data).returning();
    return session;
  }

  async findById(id: string): Promise<OAuthSession | undefined> {
    const [session] = await db.select().from(oauthSessions).where(eq(oauthSessions.id, id));
    return session;
  }

  async findByOrgAndProvider(
    organizationId: string,
    provider: string,
    userId?: string,
  ): Promise<OAuthSession | undefined> {
    const conditions = [
      eq(oauthSessions.organization_id, organizationId),
      eq(oauthSessions.provider, provider),
      eq(oauthSessions.is_valid, true),
    ];

    if (userId) {
      conditions.push(eq(oauthSessions.user_id, userId));
    }

    const [session] = await db
      .select()
      .from(oauthSessions)
      .where(and(...conditions));

    return session;
  }

  async listByOrganization(organizationId: string): Promise<OAuthSession[]> {
    return db
      .select()
      .from(oauthSessions)
      .where(eq(oauthSessions.organization_id, organizationId))
      .orderBy(oauthSessions.provider);
  }

  async update(id: string, data: Partial<NewOAuthSession>): Promise<OAuthSession | undefined> {
    const [session] = await db
      .update(oauthSessions)
      .set({ ...data, updated_at: new Date() })
      .where(eq(oauthSessions.id, id))
      .returning();
    return session;
  }

  async revoke(id: string, reason: string): Promise<OAuthSession | undefined> {
    const [session] = await db
      .update(oauthSessions)
      .set({
        is_valid: false,
        revoked_at: new Date(),
        revoke_reason: reason,
        updated_at: new Date(),
      })
      .where(eq(oauthSessions.id, id))
      .returning();
    return session;
  }

  async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(oauthSessions)
      .where(eq(oauthSessions.id, id))
      .returning({ id: oauthSessions.id });
    return result.length > 0;
  }

  async recordUsage(id: string): Promise<void> {
    await db
      .update(oauthSessions)
      .set({ last_used_at: new Date() })
      .where(eq(oauthSessions.id, id));
  }

  async recordRefresh(id: string): Promise<void> {
    await db
      .update(oauthSessions)
      .set({
        last_refreshed_at: new Date(),
        refresh_count: sql`${oauthSessions.refresh_count} + 1`,
        updated_at: new Date(),
      })
      .where(eq(oauthSessions.id, id));
  }

  async findNeedingRefresh(): Promise<OAuthSession[]> {
    const now = new Date();

    return db
      .select()
      .from(oauthSessions)
      .where(
        and(
          eq(oauthSessions.is_valid, true),
          lte(oauthSessions.access_token_expires_at, now),
          sql`${oauthSessions.encrypted_refresh_token} IS NOT NULL`,
        ),
      );
  }
}

class SecretAuditLogRepository {
  async create(data: NewSecretAuditLog): Promise<SecretAuditLog> {
    const [entry] = await db.insert(secretAuditLog).values(data).returning();
    return entry;
  }

  async findBySecret(secretId: string, limit = 100): Promise<SecretAuditLog[]> {
    return db
      .select()
      .from(secretAuditLog)
      .where(eq(secretAuditLog.secret_id, secretId))
      .orderBy(desc(secretAuditLog.created_at))
      .limit(limit);
  }

  async findByOrganization(organizationId: string, limit = 100): Promise<SecretAuditLog[]> {
    return db
      .select()
      .from(secretAuditLog)
      .where(eq(secretAuditLog.organization_id, organizationId))
      .orderBy(desc(secretAuditLog.created_at))
      .limit(limit);
  }

  async findByTimeRange(
    organizationId: string,
    start: Date,
    end: Date,
    limit = 1000,
  ): Promise<SecretAuditLog[]> {
    return db
      .select()
      .from(secretAuditLog)
      .where(
        and(
          eq(secretAuditLog.organization_id, organizationId),
          gte(secretAuditLog.created_at, start),
          lte(secretAuditLog.created_at, end),
        ),
      )
      .orderBy(desc(secretAuditLog.created_at))
      .limit(limit);
  }

  async findByActor(actorType: string, actorId: string, limit = 100): Promise<SecretAuditLog[]> {
    return db
      .select()
      .from(secretAuditLog)
      .where(
        and(
          eq(
            secretAuditLog.actor_type,
            actorType as "user" | "api_key" | "system" | "deployment" | "workflow",
          ),
          eq(secretAuditLog.actor_id, actorId),
        ),
      )
      .orderBy(desc(secretAuditLog.created_at))
      .limit(limit);
  }
}

class SecretBindingsRepository {
  async create(data: NewSecretBinding): Promise<SecretBinding> {
    const [binding] = await db.insert(secretBindings).values(data).returning();
    return binding;
  }

  async createMany(data: NewSecretBinding[]): Promise<SecretBinding[]> {
    if (data.length === 0) return [];
    return db.insert(secretBindings).values(data).returning();
  }

  async findById(id: string): Promise<SecretBinding | undefined> {
    const [binding] = await db.select().from(secretBindings).where(eq(secretBindings.id, id));
    return binding;
  }

  async findByIdAndOrg(id: string, organizationId: string): Promise<SecretBinding | undefined> {
    const [binding] = await db
      .select()
      .from(secretBindings)
      .where(and(eq(secretBindings.id, id), eq(secretBindings.organization_id, organizationId)));
    return binding;
  }

  async findBySecret(secretId: string): Promise<SecretBinding[]> {
    return db.select().from(secretBindings).where(eq(secretBindings.secret_id, secretId));
  }

  async findByProject(
    projectId: string,
    projectType?: SecretProjectType,
  ): Promise<SecretBinding[]> {
    const conditions = [eq(secretBindings.project_id, projectId)];
    if (projectType) {
      conditions.push(eq(secretBindings.project_type, projectType));
    }
    return db
      .select()
      .from(secretBindings)
      .where(and(...conditions));
  }

  async findByOrgAndProject(
    organizationId: string,
    projectId: string,
    projectType?: SecretProjectType,
    limit = 100,
    offset = 0,
  ): Promise<{ bindings: SecretBinding[]; total: number }> {
    const conditions = [
      eq(secretBindings.organization_id, organizationId),
      eq(secretBindings.project_id, projectId),
    ];
    if (projectType) {
      conditions.push(eq(secretBindings.project_type, projectType));
    }

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(secretBindings)
      .where(and(...conditions));

    const bindings = await db
      .select()
      .from(secretBindings)
      .where(and(...conditions))
      .limit(limit)
      .offset(offset);

    return { bindings, total: countResult?.count ?? 0 };
  }

  async findBySecretAndProject(
    secretId: string,
    projectId: string,
    projectType: SecretProjectType,
  ): Promise<SecretBinding | undefined> {
    const [binding] = await db
      .select()
      .from(secretBindings)
      .where(
        and(
          eq(secretBindings.secret_id, secretId),
          eq(secretBindings.project_id, projectId),
          eq(secretBindings.project_type, projectType),
        ),
      );
    return binding;
  }

  async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(secretBindings)
      .where(eq(secretBindings.id, id))
      .returning({ id: secretBindings.id });
    return result.length > 0;
  }

  async deleteBySecret(secretId: string): Promise<number> {
    const result = await db
      .delete(secretBindings)
      .where(eq(secretBindings.secret_id, secretId))
      .returning({ id: secretBindings.id });
    return result.length;
  }

  async deleteByProject(projectId: string, projectType?: SecretProjectType): Promise<number> {
    const conditions = [eq(secretBindings.project_id, projectId)];
    if (projectType) {
      conditions.push(eq(secretBindings.project_type, projectType));
    }
    const result = await db
      .delete(secretBindings)
      .where(and(...conditions))
      .returning({ id: secretBindings.id });
    return result.length;
  }
}

class AppSecretRequirementsRepository {
  async create(data: NewAppSecretRequirement): Promise<AppSecretRequirement> {
    const [req] = await db.insert(appSecretRequirements).values(data).returning();
    return req;
  }

  async createMany(data: NewAppSecretRequirement[]): Promise<AppSecretRequirement[]> {
    if (data.length === 0) return [];
    return db.insert(appSecretRequirements).values(data).returning();
  }

  async findById(id: string): Promise<AppSecretRequirement | undefined> {
    const [req] = await db
      .select()
      .from(appSecretRequirements)
      .where(eq(appSecretRequirements.id, id));
    return req;
  }

  async findByApp(appId: string): Promise<AppSecretRequirement[]> {
    return db
      .select()
      .from(appSecretRequirements)
      .where(eq(appSecretRequirements.app_id, appId))
      .orderBy(appSecretRequirements.secret_name);
  }

  async findApprovedByApp(appId: string): Promise<AppSecretRequirement[]> {
    return db
      .select()
      .from(appSecretRequirements)
      .where(and(eq(appSecretRequirements.app_id, appId), eq(appSecretRequirements.approved, true)))
      .orderBy(appSecretRequirements.secret_name);
  }

  async findByAppAndSecret(
    appId: string,
    secretName: string,
  ): Promise<AppSecretRequirement | undefined> {
    const [req] = await db
      .select()
      .from(appSecretRequirements)
      .where(
        and(
          eq(appSecretRequirements.app_id, appId),
          eq(appSecretRequirements.secret_name, secretName),
        ),
      );
    return req;
  }

  async approve(id: string, approvedBy: string): Promise<AppSecretRequirement | undefined> {
    const [req] = await db
      .update(appSecretRequirements)
      .set({
        approved: true,
        approved_by: approvedBy,
        approved_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(appSecretRequirements.id, id))
      .returning();
    return req;
  }

  async revoke(id: string): Promise<AppSecretRequirement | undefined> {
    const [req] = await db
      .update(appSecretRequirements)
      .set({
        approved: false,
        approved_by: null,
        approved_at: null,
        updated_at: new Date(),
      })
      .where(eq(appSecretRequirements.id, id))
      .returning();
    return req;
  }

  async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(appSecretRequirements)
      .where(eq(appSecretRequirements.id, id))
      .returning({ id: appSecretRequirements.id });
    return result.length > 0;
  }

  async deleteByApp(appId: string): Promise<number> {
    const result = await db
      .delete(appSecretRequirements)
      .where(eq(appSecretRequirements.app_id, appId))
      .returning({ id: appSecretRequirements.id });
    return result.length;
  }

  async syncRequirements(
    appId: string,
    requirements: Array<{ secretName: string; required: boolean }>,
  ): Promise<AppSecretRequirement[]> {
    const existing = await this.findByApp(appId);
    const existingMap = new Map(existing.map((r) => [r.secret_name, r]));

    const toAdd: NewAppSecretRequirement[] = [];
    const toKeep = new Set<string>();

    for (const req of requirements) {
      const existingReq = existingMap.get(req.secretName);
      if (existingReq) {
        toKeep.add(existingReq.id);
        if (existingReq.required !== req.required) {
          await db
            .update(appSecretRequirements)
            .set({ required: req.required, updated_at: new Date() })
            .where(eq(appSecretRequirements.id, existingReq.id));
        }
      } else {
        toAdd.push({
          app_id: appId,
          secret_name: req.secretName,
          required: req.required,
        });
      }
    }

    const toRemove = existing.filter((r) => !toKeep.has(r.id));
    for (const req of toRemove) {
      await this.delete(req.id);
    }

    if (toAdd.length > 0) {
      await this.createMany(toAdd);
    }

    return this.findByApp(appId);
  }
}

export const secretsRepository = new SecretsRepository();
export const oauthSessionsRepository = new OAuthSessionsRepository();
export const secretAuditLogRepository = new SecretAuditLogRepository();
export const secretBindingsRepository = new SecretBindingsRepository();
export const appSecretRequirementsRepository = new AppSecretRequirementsRepository();

export type {
  AppSecretRequirement,
  NewAppSecretRequirement,
  NewOAuthSession,
  NewSecret,
  NewSecretAuditLog,
  NewSecretBinding,
  OAuthSession,
  Secret,
  SecretAuditLog,
  SecretBinding,
};
