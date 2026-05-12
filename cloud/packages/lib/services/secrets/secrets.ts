import {
  type AppSecretRequirement,
  appSecretRequirementsRepository,
  type OAuthSession,
  oauthSessionsRepository,
  type Secret,
  secretAuditLogRepository,
  secretBindingsRepository,
  secretsRepository,
} from "@/db/repositories/secrets";
import type {
  SecretActorType,
  SecretAuditAction,
  SecretEnvironment,
  SecretProjectType,
  SecretProvider,
  SecretScope,
} from "@/db/schemas/secrets";
import { getEncryptionService, type SecretsEncryptionService } from "./encryption";

const MAX_SECRET_VALUE_BYTES = 65536; // 64KB max for secret values

export interface CreateSecretParams {
  organizationId: string;
  name: string;
  value: string;
  scope?: SecretScope;
  projectId?: string;
  projectType?: SecretProjectType;
  environment?: SecretEnvironment;
  description?: string;
  provider?: SecretProvider;
  providerMetadata?: {
    pattern?: string;
    testUrl?: string;
    testMethod?: string;
    validated?: boolean;
    lastValidatedAt?: string;
  };
  expiresAt?: Date;
  createdBy: string;
}

export interface BulkCreateSecretParams {
  organizationId: string;
  secrets: Array<{
    name: string;
    value: string;
    description?: string;
    provider?: SecretProvider;
  }>;
  createdBy: string;
}

export interface UpdateSecretParams {
  value?: string;
  description?: string;
  expiresAt?: Date | null;
}

export interface GetSecretsParams {
  organizationId: string;
  projectId?: string;
  projectType?: SecretProjectType;
  environment?: SecretEnvironment;
  provider?: SecretProvider;
  names?: string[];
  includeBindings?: boolean;
  scope?: SecretScope;
}

export interface ListSecretsParams {
  organizationId: string;
  projectId?: string;
  projectType?: SecretProjectType;
  environment?: SecretEnvironment;
  provider?: SecretProvider;
  limit?: number;
  offset?: number;
}

export interface BindSecretParams {
  secretId: string;
  projectId: string;
  projectType: SecretProjectType;
  createdBy: string;
}

export interface AuditContext {
  actorType: SecretActorType;
  actorId: string;
  actorEmail?: string;
  ipAddress?: string;
  userAgent?: string;
  source?: string;
  requestId?: string;
  endpoint?: string;
}

export interface SecretMetadata {
  id: string;
  name: string;
  description: string | null;
  scope: "organization" | "project" | "environment";
  projectId: string | null;
  projectType: string | null;
  environment: "development" | "preview" | "production" | null;
  provider: SecretProvider | null;
  providerMetadata: {
    pattern?: string;
    testUrl?: string;
    testMethod?: string;
    validated?: boolean;
    lastValidatedAt?: string;
  } | null;
  version: number;
  expiresAt: Date | null;
  lastRotatedAt: Date | null;
  lastAccessedAt: Date | null;
  accessCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SecretBindingMetadata {
  id: string;
  secretId: string;
  secretName: string;
  projectId: string;
  projectType: SecretProjectType;
  createdAt: Date;
}

class SecretsService {
  private encryption: SecretsEncryptionService;

  constructor(encryption?: SecretsEncryptionService) {
    this.encryption = encryption || getEncryptionService();
  }

  isConfigured(): boolean {
    return this.encryption.isConfigured();
  }

  async create(params: CreateSecretParams, audit: AuditContext): Promise<SecretMetadata> {
    const {
      organizationId,
      name,
      value,
      scope = "organization",
      projectId,
      projectType,
      environment,
      description,
      provider,
      providerMetadata,
      expiresAt,
      createdBy,
    } = params;

    const existing = await secretsRepository.findByName(
      organizationId,
      name,
      projectId,
      environment,
    );

    if (existing) {
      throw new Error(
        `Secret '${name}' already exists in this context. Use update or rotate instead.`,
      );
    }

    const { encrypted_value, encrypted_dek, nonce, auth_tag, encryption_key_id } =
      await this.encryptValue(value);

    const secret = await secretsRepository.create({
      organization_id: organizationId,
      name,
      scope,
      project_id: projectId,
      project_type: projectType,
      environment,
      description,
      provider,
      provider_metadata: providerMetadata,
      encrypted_value,
      encryption_key_id,
      encrypted_dek,
      nonce,
      auth_tag,
      expires_at: expiresAt,
      created_by: createdBy,
    });

    await this.logAudit(secret.id, organizationId, "created", name, audit);
    return this.toMetadata(secret);
  }

  async get(
    organizationId: string,
    name: string,
    projectId?: string,
    environment?: SecretEnvironment,
    audit?: AuditContext,
  ): Promise<string | null> {
    const secret = await secretsRepository.findByName(organizationId, name, projectId, environment);

    if (!secret) return null;

    const value = await this.decryptSecret(secret);
    await secretsRepository.recordAccess(secret.id);
    if (audit) await this.logAudit(secret.id, organizationId, "read", name, audit);
    return value;
  }

  async getDecryptedValue(
    secretId: string,
    organizationId: string,
    audit?: AuditContext,
  ): Promise<string> {
    const secret = await this.getExistingSecret(secretId, organizationId);
    const value = await this.decryptSecret(secret);
    await secretsRepository.recordAccess(secretId);
    if (audit) await this.logAudit(secretId, organizationId, "read", secret.name, audit);
    return value;
  }

  async getDecrypted(
    params: GetSecretsParams,
    audit?: AuditContext,
  ): Promise<Record<string, string>> {
    const secrets = await secretsRepository.findByContext({
      organizationId: params.organizationId,
      projectId: params.projectId,
      projectType: params.projectType,
      environment: params.environment,
      provider: params.provider,
      names: params.names,
      includeBindings: params.includeBindings,
      scope: params.scope,
    });

    const result: Record<string, string> = {};
    for (const secret of secrets) {
      result[secret.name] = await this.decryptSecret(secret);
      await secretsRepository.recordAccess(secret.id);
      if (audit) await this.logAudit(secret.id, params.organizationId, "read", secret.name, audit);
    }
    return result;
  }

  async list(organizationId: string): Promise<SecretMetadata[]> {
    const secrets = await secretsRepository.listByOrganization(organizationId);
    return secrets.map(this.toMetadata);
  }

  async listByProject(projectId: string): Promise<SecretMetadata[]> {
    const secrets = await secretsRepository.listByProject(projectId);
    return secrets.map(this.toMetadata);
  }

  async update(
    secretId: string,
    organizationId: string,
    params: UpdateSecretParams,
    audit: AuditContext,
  ): Promise<SecretMetadata> {
    const existing = await this.getExistingSecret(secretId, organizationId);
    const updateData: Record<string, unknown> = {};

    if (params.value !== undefined) {
      Object.assign(updateData, await this.encryptValue(params.value), {
        version: existing.version + 1,
      });
    }
    if (params.description !== undefined) updateData.description = params.description;
    if (params.expiresAt !== undefined) updateData.expires_at = params.expiresAt;

    const updated = await secretsRepository.update(secretId, updateData as Partial<Secret>);
    if (!updated) throw new Error("Failed to update secret");

    await this.logAudit(secretId, organizationId, "updated", existing.name, audit);
    return this.toMetadata(updated);
  }

  async rotate(
    secretId: string,
    organizationId: string,
    newValue: string,
    audit: AuditContext,
  ): Promise<SecretMetadata> {
    const encrypted = await this.encryptValue(newValue);
    const existing = await this.getExistingSecret(secretId, organizationId);

    const updated = await secretsRepository.update(secretId, {
      ...encrypted,
      version: existing.version + 1,
      last_rotated_at: new Date(),
    });
    if (!updated) throw new Error("Failed to rotate secret");

    await this.logAudit(secretId, organizationId, "rotated", existing.name, audit);
    return this.toMetadata(updated);
  }

  private async getExistingSecret(secretId: string, organizationId: string): Promise<Secret> {
    const existing = await secretsRepository.findById(secretId);
    if (!existing || existing.organization_id !== organizationId) {
      throw new Error("Secret not found");
    }
    return existing;
  }

  private async encryptValue(value: string) {
    if (Buffer.byteLength(value, "utf8") > MAX_SECRET_VALUE_BYTES) {
      throw new Error(`Secret value exceeds maximum size of ${MAX_SECRET_VALUE_BYTES} bytes`);
    }
    const { encryptedValue, encryptedDek, nonce, authTag, keyId } =
      await this.encryption.encrypt(value);
    return {
      encrypted_value: encryptedValue,
      encrypted_dek: encryptedDek,
      nonce,
      auth_tag: authTag,
      encryption_key_id: keyId,
    };
  }

  async delete(secretId: string, organizationId: string, audit: AuditContext): Promise<void> {
    const existing = await this.getExistingSecret(secretId, organizationId);
    const deleted = await secretsRepository.delete(secretId);
    if (!deleted) throw new Error("Failed to delete secret");
    await this.logAudit(secretId, organizationId, "deleted", existing.name, audit);
  }

  async deleteByName(
    organizationId: string,
    name: string,
    audit: AuditContext,
    projectId?: string,
    environment?: SecretEnvironment,
  ): Promise<void> {
    const existing = await secretsRepository.findByName(
      organizationId,
      name,
      projectId,
      environment,
    );
    if (!existing) return;
    await this.delete(existing.id, organizationId, audit);
  }

  async storeOAuthTokens(params: {
    organizationId: string;
    userId?: string;
    provider: string;
    providerAccountId?: string;
    accessToken: string;
    refreshToken?: string;
    tokenType?: string;
    scopes?: string[];
    accessTokenExpiresAt?: Date;
    refreshTokenExpiresAt?: Date;
    providerData?: Record<string, unknown>;
  }): Promise<OAuthSession> {
    const {
      organizationId,
      userId,
      provider,
      providerAccountId,
      accessToken,
      refreshToken,
      tokenType = "Bearer",
      scopes = [],
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      providerData,
    } = params;

    const {
      encryptedValue: encryptedAccessToken,
      encryptedDek,
      nonce,
      authTag,
      keyId,
    } = await this.encryption.encrypt(accessToken);

    let encryptedRefreshToken: string | undefined;
    let refreshEncryptedDek: string | undefined;
    let refreshNonce: string | undefined;
    let refreshAuthTag: string | undefined;
    if (refreshToken) {
      const refreshResult = await this.encryption.encrypt(refreshToken);
      encryptedRefreshToken = refreshResult.encryptedValue;
      refreshEncryptedDek = refreshResult.encryptedDek;
      refreshNonce = refreshResult.nonce;
      refreshAuthTag = refreshResult.authTag;
    }

    let encryptedProviderData: string | undefined;
    let providerDataNonce: string | undefined;
    let providerDataAuthTag: string | undefined;
    if (providerData) {
      const dataResult = await this.encryption.encrypt(JSON.stringify(providerData));
      encryptedProviderData = dataResult.encryptedValue;
      providerDataNonce = dataResult.nonce;
      providerDataAuthTag = dataResult.authTag;
    }

    const existing = await oauthSessionsRepository.findByOrgAndProvider(
      organizationId,
      provider,
      userId,
    );

    if (existing) {
      const updated = await oauthSessionsRepository.update(existing.id, {
        encrypted_access_token: encryptedAccessToken,
        encrypted_refresh_token: encryptedRefreshToken,
        encryption_key_id: keyId,
        encrypted_dek: encryptedDek,
        nonce,
        auth_tag: authTag,
        refresh_encrypted_dek: refreshEncryptedDek,
        refresh_nonce: refreshNonce,
        refresh_auth_tag: refreshAuthTag,
        token_type: tokenType,
        scopes,
        access_token_expires_at: accessTokenExpiresAt,
        refresh_token_expires_at: refreshTokenExpiresAt,
        encrypted_provider_data: encryptedProviderData,
        provider_data_nonce: providerDataNonce,
        provider_data_auth_tag: providerDataAuthTag,
        is_valid: true,
        revoked_at: null,
        revoke_reason: null,
      });

      if (!updated) {
        throw new Error("Failed to update OAuth session");
      }
      return updated;
    }

    return oauthSessionsRepository.create({
      organization_id: organizationId,
      user_id: userId,
      provider,
      provider_account_id: providerAccountId,
      encrypted_access_token: encryptedAccessToken,
      encrypted_refresh_token: encryptedRefreshToken,
      token_type: tokenType,
      encryption_key_id: keyId,
      encrypted_dek: encryptedDek,
      nonce,
      auth_tag: authTag,
      refresh_encrypted_dek: refreshEncryptedDek,
      refresh_nonce: refreshNonce,
      refresh_auth_tag: refreshAuthTag,
      scopes,
      access_token_expires_at: accessTokenExpiresAt,
      refresh_token_expires_at: refreshTokenExpiresAt,
      encrypted_provider_data: encryptedProviderData,
      provider_data_nonce: providerDataNonce,
      provider_data_auth_tag: providerDataAuthTag,
    });
  }

  async getOAuthTokens(
    organizationId: string,
    provider: string,
    userId?: string,
  ): Promise<{
    accessToken: string;
    refreshToken?: string;
    tokenType: string;
    scopes: string[];
    isExpired: boolean;
    expiresAt?: Date;
  } | null> {
    const session = await oauthSessionsRepository.findByOrgAndProvider(
      organizationId,
      provider,
      userId,
    );

    if (!session) return null;

    const accessToken = await this.encryption.decrypt({
      encryptedValue: session.encrypted_access_token,
      encryptedDek: session.encrypted_dek,
      nonce: session.nonce,
      authTag: session.auth_tag,
    });

    let refreshToken: string | undefined;
    if (
      session.encrypted_refresh_token &&
      session.refresh_encrypted_dek &&
      session.refresh_nonce &&
      session.refresh_auth_tag
    ) {
      refreshToken = await this.encryption.decrypt({
        encryptedValue: session.encrypted_refresh_token,
        encryptedDek: session.refresh_encrypted_dek,
        nonce: session.refresh_nonce,
        authTag: session.refresh_auth_tag,
      });
    }

    const isExpired = session.access_token_expires_at
      ? new Date() > session.access_token_expires_at
      : false;

    await oauthSessionsRepository.recordUsage(session.id);

    return {
      accessToken,
      refreshToken,
      tokenType: session.token_type ?? "Bearer",
      scopes: session.scopes,
      isExpired,
      expiresAt: session.access_token_expires_at ?? undefined,
    };
  }

  async listOAuthConnections(organizationId: string): Promise<
    Array<{
      id: string;
      provider: string;
      providerAccountId: string | null;
      scopes: string[];
      isValid: boolean;
      expiresAt: Date | null;
      lastUsedAt: Date | null;
      createdAt: Date;
    }>
  > {
    const sessions = await oauthSessionsRepository.listByOrganization(organizationId);
    return sessions.map((s) => ({
      id: s.id,
      provider: s.provider,
      providerAccountId: s.provider_account_id,
      scopes: s.scopes,
      isValid: s.is_valid,
      expiresAt: s.access_token_expires_at,
      lastUsedAt: s.last_used_at,
      createdAt: s.created_at,
    }));
  }

  async revokeOAuthConnection(
    sessionId: string,
    organizationId: string,
    reason: string,
  ): Promise<void> {
    const session = await oauthSessionsRepository.findById(sessionId);
    if (!session || session.organization_id !== organizationId) {
      throw new Error("OAuth session not found");
    }

    await oauthSessionsRepository.revoke(sessionId, reason);
  }

  async getSecretAuditLog(secretId: string, limit = 100) {
    return secretAuditLogRepository.findBySecret(secretId, limit);
  }

  async getOrganizationAuditLog(organizationId: string, limit = 100) {
    return secretAuditLogRepository.findByOrganization(organizationId, limit);
  }

  async bulkCreate(
    params: BulkCreateSecretParams,
    audit: AuditContext,
  ): Promise<{
    created: SecretMetadata[];
    errors: Array<{ name: string; error: string }>;
  }> {
    const { organizationId, secrets: secretsToCreate, createdBy } = params;
    const created: SecretMetadata[] = [];
    const errors: Array<{ name: string; error: string }> = [];

    for (const secretData of secretsToCreate) {
      const { name, value, description, provider } = secretData;

      const existing = await secretsRepository.findByName(organizationId, name);
      if (existing) {
        errors.push({ name, error: `Secret '${name}' already exists` });
        continue;
      }

      let encrypted;
      try {
        encrypted = await this.encryptValue(value);
      } catch (error) {
        errors.push({
          name,
          error: error instanceof Error ? error.message : "Encryption failed",
        });
        continue;
      }

      const secret = await secretsRepository.create({
        organization_id: organizationId,
        name,
        scope: "organization",
        description,
        provider,
        ...encrypted,
        created_by: createdBy,
      });

      await this.logAudit(secret.id, organizationId, "created", name, audit);
      created.push(this.toMetadata(secret));
    }

    return { created, errors };
  }

  async listFiltered(
    params: ListSecretsParams,
  ): Promise<{ secrets: SecretMetadata[]; total: number }> {
    const result = await secretsRepository.listFiltered({
      organizationId: params.organizationId,
      projectId: params.projectId,
      projectType: params.projectType,
      environment: params.environment,
      provider: params.provider,
      limit: params.limit,
      offset: params.offset,
    });
    return {
      secrets: result.secrets.map(this.toMetadata),
      total: result.total,
    };
  }

  async bindSecret(params: BindSecretParams, audit: AuditContext): Promise<SecretBindingMetadata> {
    const result = await this.bindSecrets(
      [params.secretId],
      params.projectId,
      params.projectType,
      params.createdBy,
      audit,
    );
    if (result.errors.length > 0) throw new Error(result.errors[0].error);
    return result.bound[0];
  }

  async bindSecrets(
    secretIds: string[],
    projectId: string,
    projectType: SecretProjectType,
    createdBy: string,
    audit: AuditContext,
  ): Promise<{
    bound: SecretBindingMetadata[];
    errors: Array<{ secretId: string; error: string }>;
  }> {
    const bound: SecretBindingMetadata[] = [];
    const errors: Array<{ secretId: string; error: string }> = [];

    for (const secretId of secretIds) {
      const secret = await secretsRepository.findById(secretId);
      if (!secret) {
        errors.push({ secretId, error: "Secret not found" });
        continue;
      }

      const existing = await secretBindingsRepository.findBySecretAndProject(
        secretId,
        projectId,
        projectType,
      );
      if (existing) {
        errors.push({ secretId, error: "Already bound" });
        continue;
      }

      const binding = await secretBindingsRepository.create({
        organization_id: secret.organization_id,
        secret_id: secretId,
        project_id: projectId,
        project_type: projectType,
        created_by: createdBy,
      });

      bound.push({
        id: binding.id,
        secretId: binding.secret_id,
        secretName: secret.name,
        projectId: binding.project_id,
        projectType: binding.project_type,
        createdAt: binding.created_at,
      });
    }

    return { bound, errors };
  }

  async unbindSecret(
    bindingId: string,
    organizationId: string,
    audit: AuditContext,
  ): Promise<void> {
    const binding = await secretBindingsRepository.findByIdAndOrg(bindingId, organizationId);
    if (!binding) {
      throw new Error("Binding not found");
    }

    await secretBindingsRepository.delete(bindingId);
  }

  async listBindings(
    organizationId: string,
    projectId: string,
    projectType?: SecretProjectType,
    limit = 100,
    offset = 0,
  ): Promise<{ bindings: SecretBindingMetadata[]; total: number }> {
    const result = await secretBindingsRepository.findByOrgAndProject(
      organizationId,
      projectId,
      projectType,
      limit,
      offset,
    );

    const bindings: SecretBindingMetadata[] = [];
    for (const binding of result.bindings) {
      const secret = await secretsRepository.findById(binding.secret_id);
      if (!secret) continue;
      bindings.push({
        id: binding.id,
        secretId: binding.secret_id,
        secretName: secret.name,
        projectId: binding.project_id,
        projectType: binding.project_type,
        createdAt: binding.created_at,
      });
    }

    return { bindings, total: result.total };
  }

  async listSecretBindings(secretId: string): Promise<SecretBindingMetadata[]> {
    const bindings = await secretBindingsRepository.findBySecret(secretId);
    const secret = await secretsRepository.findById(secretId);
    if (!secret) {
      throw new Error("Secret not found");
    }

    return bindings.map((b) => ({
      id: b.id,
      secretId: b.secret_id,
      secretName: secret.name,
      projectId: b.project_id,
      projectType: b.project_type,
      createdAt: b.created_at,
    }));
  }

  async getAppSecretRequirements(appId: string): Promise<AppSecretRequirement[]> {
    return appSecretRequirementsRepository.findByApp(appId);
  }

  async getApprovedAppSecrets(appId: string): Promise<string[]> {
    const approved = await appSecretRequirementsRepository.findApprovedByApp(appId);
    return approved.map((r) => r.secret_name);
  }

  async syncAppSecretRequirements(
    appId: string,
    requirements: Array<{ secretName: string; required: boolean }>,
  ): Promise<AppSecretRequirement[]> {
    return appSecretRequirementsRepository.syncRequirements(appId, requirements);
  }

  async approveAppSecretRequirement(
    requirementId: string,
    approvedBy: string,
  ): Promise<AppSecretRequirement> {
    const req = await appSecretRequirementsRepository.approve(requirementId, approvedBy);
    if (!req) {
      throw new Error("Requirement not found");
    }
    return req;
  }

  async revokeAppSecretRequirement(requirementId: string): Promise<AppSecretRequirement> {
    const req = await appSecretRequirementsRepository.revoke(requirementId);
    if (!req) {
      throw new Error("Requirement not found");
    }
    return req;
  }

  async getAppSecrets(
    appId: string,
    organizationId: string,
    audit?: AuditContext,
  ): Promise<Record<string, string>> {
    // 1. Get app's own project-scoped secrets (always accessible)
    const appSecrets = await this.getDecrypted(
      {
        organizationId,
        projectId: appId,
        projectType: "app",
        scope: "project",
      },
      audit,
    );

    // 2. Get approved org-level secrets bound to this app
    const approvedNames = await this.getApprovedAppSecrets(appId);
    if (approvedNames.length === 0) {
      return appSecrets;
    }

    const approvedOrgSecrets = await this.getDecrypted(
      { organizationId, names: approvedNames, scope: "organization" },
      audit,
    );

    // App's own secrets take precedence over org secrets with same name
    return { ...approvedOrgSecrets, ...appSecrets };
  }

  private async logAudit(
    secretId: string,
    organizationId: string,
    action: SecretAuditAction,
    secretName: string,
    context: AuditContext,
  ): Promise<void> {
    await secretAuditLogRepository.create({
      secret_id: secretId,
      organization_id: organizationId,
      action,
      secret_name: secretName,
      actor_type: context.actorType,
      actor_id: context.actorId,
      actor_email: context.actorEmail,
      ip_address: context.ipAddress,
      user_agent: context.userAgent,
      source: context.source,
      request_id: context.requestId,
      endpoint: context.endpoint,
    });
  }

  private decryptSecret(secret: Secret) {
    return this.encryption.decrypt({
      encryptedValue: secret.encrypted_value,
      encryptedDek: secret.encrypted_dek,
      nonce: secret.nonce,
      authTag: secret.auth_tag,
    });
  }

  private toMetadata(secret: Secret): SecretMetadata {
    return {
      id: secret.id,
      name: secret.name,
      description: secret.description,
      scope: secret.scope,
      projectId: secret.project_id,
      projectType: secret.project_type,
      environment: secret.environment,
      provider: secret.provider,
      providerMetadata: secret.provider_metadata,
      version: secret.version,
      expiresAt: secret.expires_at,
      lastRotatedAt: secret.last_rotated_at,
      lastAccessedAt: secret.last_accessed_at,
      accessCount: secret.access_count,
      createdAt: secret.created_at,
      updatedAt: secret.updated_at,
    };
  }

  async getSystemSecret(name: string): Promise<string | null> {
    const systemOrgId = process.env.SYSTEM_ORG_ID || "system";
    return this.get(systemOrgId, name);
  }

  async createSystemSecret(name: string, value: string): Promise<SecretMetadata> {
    const systemOrgId = process.env.SYSTEM_ORG_ID || "system";
    const audit: AuditContext = {
      actorType: "system",
      actorId: "platform-credentials",
      source: "system",
    };

    const existing = await secretsRepository.findByName(systemOrgId, name);
    if (existing) {
      return this.update(existing.id, systemOrgId, { value }, audit);
    }

    return this.create(
      {
        organizationId: systemOrgId,
        name,
        value,
        scope: "organization",
        createdBy: "system",
      },
      audit,
    );
  }
}

let instance: SecretsService | null = null;

export const getSecretsService = () => instance || (instance = new SecretsService());

export const secretsService = new Proxy({} as SecretsService & { isConfigured: boolean }, {
  get(_, prop: keyof SecretsService | "isConfigured") {
    const svc = getSecretsService();
    if (prop === "isConfigured") return svc.isConfigured();
    const val = svc[prop];
    return typeof val === "function" ? val.bind(svc) : val;
  },
});

export { SecretsService };
