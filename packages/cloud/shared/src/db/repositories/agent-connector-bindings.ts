/**
 * Tenant-scoped persistence for agent connector bindings. Public projections
 * deliberately omit the platform credential locator; execution-only reads keep
 * it inside the Cloud service boundary.
 */
import type { AgentConnectorBinding } from "@elizaos/core";
import {
  canonicalGoogleMcpProduct,
  GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES,
  googleMcpProductCapabilities,
} from "@elizaos/shared/contracts";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { type DbTransaction, dbRead } from "../client";
import { writeTransaction } from "../helpers";
import {
  agentConnectorBindings,
  type CloudConnectorBindingRole,
} from "../schemas/agent-connector-bindings";
import { platformCredentials } from "../schemas/platform-credentials";
import { userCharacters } from "../schemas/user-characters";

export interface BindAgentConnectorInput {
  organizationId: string;
  agentId: string;
  platformCredentialId: string;
  provider: string;
  role: CloudConnectorBindingRole;
  purposes: string[];
  accessGate: string;
  selectedProducts: string[];
  isDefault: boolean;
  authorizedByUserId: string;
  ownerBindingId?: string;
  ownerIdentityId?: string;
  requireVerifiedOwner: boolean;
  metadata?: Record<string, unknown>;
}

export interface AgentConnectorExecutionBinding {
  binding: AgentConnectorBinding;
  organizationId: string;
  platformCredentialId: string;
  credentialStatus: "pending" | "active" | "expired" | "revoked" | "error";
}

export class AgentConnectorBindingRepositoryError extends Error {
  constructor(
    public readonly code:
      | "AGENT_NOT_FOUND"
      | "CREDENTIAL_NOT_FOUND"
      | "PROVIDER_MISMATCH"
      | "OWNER_NOT_VERIFIED"
      | "UNSUPPORTED_PRODUCT",
    message: string,
  ) {
    super(message);
    this.name = "AgentConnectorBindingRepositoryError";
  }
}

type BindingRow = typeof agentConnectorBindings.$inferSelect;
type CredentialRow = typeof platformCredentials.$inferSelect;

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function canonicalSelectedProducts(provider: string, values: readonly string[]): string[] {
  const unique = uniqueStrings(values);
  if (provider !== "google") return unique;
  return [
    ...new Set(
      unique.map((product) => {
        const canonical = canonicalGoogleMcpProduct(product);
        if (!canonical) {
          throw new AgentConnectorBindingRepositoryError(
            "UNSUPPORTED_PRODUCT",
            `Unsupported Google MCP product: ${product}.`,
          );
        }
        return canonical;
      }),
    ),
  ];
}

function deriveAllowedCapabilities(
  selectedProducts: readonly string[],
  grantedScopes: readonly string[],
): string[] {
  const scopes = new Set(grantedScopes);
  const capabilities = new Set<string>();
  for (const selected of selectedProducts) {
    const product = canonicalGoogleMcpProduct(selected);
    if (!product) continue;
    for (const capability of googleMcpProductCapabilities(product)) {
      const accepted = GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES[capability];
      if (accepted.some((scope) => scopes.has(scope))) capabilities.add(capability);
    }
  }
  return [...capabilities];
}

function projectBinding(row: BindingRow, credential: CredentialRow): AgentConnectorBinding {
  const displayHandle =
    credential.platform_display_name ?? credential.platform_username ?? credential.platform_email;
  return {
    id: row.id,
    agentId: row.agent_id,
    provider: row.provider,
    role: row.role,
    purposes: [...row.purposes],
    accessGate: row.access_gate,
    status: row.status,
    selectedProducts: [...row.selected_products],
    allowedCapabilities: [...row.allowed_capabilities],
    grantedScopes: [...(credential.scopes ?? [])],
    externalIdentity: {
      id: credential.platform_user_id,
      ...(displayHandle ? { displayHandle } : {}),
    },
    ...(row.owner_binding_id || row.owner_identity_id
      ? {
          ownerBinding: {
            ...(row.owner_binding_id ? { id: row.owner_binding_id } : {}),
            ...(row.owner_identity_id ? { identityId: row.owner_identity_id } : {}),
          },
        }
      : {}),
    isDefault: row.is_default,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
}

export async function bindAgentConnectorWithTransaction(
  tx: DbTransaction,
  input: BindAgentConnectorInput,
): Promise<AgentConnectorBinding> {
  const [agent] = await tx
    .select({ id: userCharacters.id, userId: userCharacters.user_id })
    .from(userCharacters)
    .where(
      and(
        eq(userCharacters.id, input.agentId),
        eq(userCharacters.organization_id, input.organizationId),
      ),
    )
    .limit(1);
  if (!agent) {
    throw new AgentConnectorBindingRepositoryError(
      "AGENT_NOT_FOUND",
      "Agent does not exist in the caller's organization.",
    );
  }

  const [credential] = await tx
    .select()
    .from(platformCredentials)
    .where(
      and(
        eq(platformCredentials.id, input.platformCredentialId),
        eq(platformCredentials.organization_id, input.organizationId),
        isNull(platformCredentials.deleted_at),
      ),
    )
    .limit(1);
  if (!credential) {
    throw new AgentConnectorBindingRepositoryError(
      "CREDENTIAL_NOT_FOUND",
      "Connector credential does not exist in the caller's organization.",
    );
  }
  if (credential.platform !== input.provider) {
    throw new AgentConnectorBindingRepositoryError(
      "PROVIDER_MISMATCH",
      "Connector credential provider does not match the requested binding provider.",
    );
  }
  if (
    input.requireVerifiedOwner &&
    (agent.userId !== input.authorizedByUserId || credential.user_id !== input.authorizedByUserId)
  ) {
    throw new AgentConnectorBindingRepositoryError(
      "OWNER_NOT_VERIFIED",
      "OWNER bindings require the authorizing user to own both agent and credential.",
    );
  }

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.organizationId}:${input.agentId}:${input.provider}`}))`,
  );

  const now = new Date();
  if (input.isDefault) {
    await tx
      .update(agentConnectorBindings)
      .set({ is_default: false, updated_at: now })
      .where(
        and(
          eq(agentConnectorBindings.organization_id, input.organizationId),
          eq(agentConnectorBindings.agent_id, input.agentId),
          eq(agentConnectorBindings.provider, input.provider),
          eq(agentConnectorBindings.role, input.role),
          isNull(agentConnectorBindings.deleted_at),
        ),
      );
  }

  const [existing] = await tx
    .select({ id: agentConnectorBindings.id })
    .from(agentConnectorBindings)
    .where(
      and(
        eq(agentConnectorBindings.organization_id, input.organizationId),
        eq(agentConnectorBindings.agent_id, input.agentId),
        eq(agentConnectorBindings.provider, input.provider),
        eq(agentConnectorBindings.platform_credential_id, input.platformCredentialId),
        isNull(agentConnectorBindings.deleted_at),
      ),
    )
    .limit(1);

  const selectedProducts = canonicalSelectedProducts(input.provider, input.selectedProducts);
  const values = {
    role: input.role,
    purposes: uniqueStrings(input.purposes),
    access_gate: input.accessGate,
    status: "connected" as const,
    selected_products: selectedProducts,
    allowed_capabilities: deriveAllowedCapabilities(selectedProducts, credential.scopes ?? []),
    is_default: input.isDefault,
    owner_binding_id: input.ownerBindingId ?? null,
    owner_identity_id: input.ownerIdentityId ?? null,
    authorized_by_user_id: input.authorizedByUserId,
    metadata: input.metadata ?? {},
    updated_at: now,
  };
  const [row] = existing
    ? await tx
        .update(agentConnectorBindings)
        .set(values)
        .where(eq(agentConnectorBindings.id, existing.id))
        .returning()
    : await tx
        .insert(agentConnectorBindings)
        .values({
          organization_id: input.organizationId,
          agent_id: input.agentId,
          platform_credential_id: input.platformCredentialId,
          provider: input.provider,
          ...values,
        })
        .returning();
  return projectBinding(row, credential);
}

export class AgentConnectorBindingsRepository {
  async bind(input: BindAgentConnectorInput): Promise<AgentConnectorBinding> {
    return writeTransaction((tx) => bindAgentConnectorWithTransaction(tx, input));
  }

  async list(organizationId: string, agentId: string): Promise<AgentConnectorBinding[]> {
    const rows = await dbRead
      .select({ binding: agentConnectorBindings, credential: platformCredentials })
      .from(agentConnectorBindings)
      .innerJoin(
        platformCredentials,
        eq(agentConnectorBindings.platform_credential_id, platformCredentials.id),
      )
      .where(
        and(
          eq(agentConnectorBindings.organization_id, organizationId),
          eq(agentConnectorBindings.agent_id, agentId),
          isNull(agentConnectorBindings.deleted_at),
        ),
      );
    return rows.map(({ binding, credential }) => projectBinding(binding, credential));
  }

  async getExecutionBinding(args: {
    organizationId: string;
    agentId: string;
    bindingId: string;
    provider?: string;
  }): Promise<AgentConnectorExecutionBinding | null> {
    const conditions = [
      eq(agentConnectorBindings.id, args.bindingId),
      eq(agentConnectorBindings.organization_id, args.organizationId),
      eq(agentConnectorBindings.agent_id, args.agentId),
      isNull(agentConnectorBindings.deleted_at),
      isNull(platformCredentials.deleted_at),
    ];
    if (args.provider) conditions.push(eq(agentConnectorBindings.provider, args.provider));
    const [row] = await dbRead
      .select({ binding: agentConnectorBindings, credential: platformCredentials })
      .from(agentConnectorBindings)
      .innerJoin(
        platformCredentials,
        eq(agentConnectorBindings.platform_credential_id, platformCredentials.id),
      )
      .where(and(...conditions))
      .limit(1);
    if (!row) return null;
    return {
      binding: projectBinding(row.binding, row.credential),
      organizationId: row.binding.organization_id,
      platformCredentialId: row.binding.platform_credential_id,
      credentialStatus: row.credential.status,
    };
  }

  async revoke(args: {
    organizationId: string;
    agentId: string;
    bindingId: string;
  }): Promise<boolean> {
    const now = new Date();
    const rows = await writeTransaction((tx) =>
      tx
        .update(agentConnectorBindings)
        .set({
          status: "revoked",
          is_default: false,
          deleted_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(agentConnectorBindings.id, args.bindingId),
            eq(agentConnectorBindings.organization_id, args.organizationId),
            eq(agentConnectorBindings.agent_id, args.agentId),
            isNull(agentConnectorBindings.deleted_at),
          ),
        )
        .returning({ id: agentConnectorBindings.id }),
    );
    return rows.length === 1;
  }

  async disableByCredential(
    organizationId: string,
    platformCredentialId: string,
  ): Promise<string[]> {
    const rows = await writeTransaction((tx) =>
      tx
        .update(agentConnectorBindings)
        .set({ status: "revoked", is_default: false, updated_at: new Date() })
        .where(
          and(
            eq(agentConnectorBindings.organization_id, organizationId),
            eq(agentConnectorBindings.platform_credential_id, platformCredentialId),
            ne(agentConnectorBindings.status, "revoked"),
            isNull(agentConnectorBindings.deleted_at),
          ),
        )
        .returning({ id: agentConnectorBindings.id }),
    );
    return rows.map((row) => row.id);
  }
}

export const agentConnectorBindingsRepository = new AgentConnectorBindingsRepository();
