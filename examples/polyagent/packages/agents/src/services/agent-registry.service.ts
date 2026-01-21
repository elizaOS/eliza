/**
 * Agent Registry Service
 *
 * Single source of truth for all agent types: USER_CONTROLLED, NPC, EXTERNAL.
 * Provides registration, discovery, and management for all agent types
 * with support for ERC-8004, Agent0 SDK, and A2A Protocol.
 *
 * @packageDocumentation
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { verifyApiKey } from "@babylon/api";
import type { JsonValue } from "@babylon/db";
import {
  type AgentRegistry,
  agentCapabilities,
  agentRegistries,
  and,
  db,
  desc,
  type ExternalAgentConnection,
  eq,
  externalAgentConnections,
  gte,
  ilike,
  inArray,
  isNull,
  or,
  type User,
  users,
} from "@babylon/db";
import { logger } from "@babylon/shared";
import type {
  AgentCapabilities,
  AgentDiscoveryFilter,
  AgentRegistration,
  ExternalAgentConnectionParams,
  TrustLevel,
} from "../types/agent-registry";
import { AgentStatus, AgentType } from "../types/agent-registry";

/**
 * Gets encryption key from environment or dev fallback
 * @internal
 */
const getEncryptionKey = () => {
  if (process.env.CRON_SECRET) return process.env.CRON_SECRET;
  if (process.env.NODE_ENV === "production") {
    throw new Error("CRON_SECRET must be set in production");
  }
  return "dev-key-change-in-production-32-chars!!";
};

/** Encryption algorithm for API key storage */
const ALGORITHM = "aes-256-cbc";

/**
 * Registry entry with loaded relations
 * @internal
 */
type RegistryWithRelations = AgentRegistry & {
  capabilities: typeof agentCapabilities.$inferSelect | null;
  User?: User | null;
  externalConnection?: ExternalAgentConnection | null;
};

/**
 * Agent Registry Service
 *
 * Service for managing agent registry with support for all agent types.
 */
export class AgentRegistryService {
  /**
   * Registers a USER_CONTROLLED agent from User record
   *
   * Creates registry entry linked to existing User. Verifies user exists
   * and is not already registered.
   *
   * @param params - Registration parameters
   * @param params.userId - User ID
   * @param params.name - Agent name
   * @param params.systemPrompt - System prompt
   * @param params.capabilities - Agent capabilities
   * @param params.trustLevel - Trust level (default: 0)
   * @returns Registered agent
   * @throws Error if user not found or already registered
   */
  async registerUserAgent(params: {
    userId: string;
    name: string;
    systemPrompt: string;
    capabilities: AgentCapabilities;
    trustLevel?: TrustLevel;
  }): Promise<AgentRegistration> {
    const { userId, name, systemPrompt, capabilities, trustLevel = 0 } = params;

    // Verify user exists
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    // Check if already registered
    const [existing] = await db
      .select()
      .from(agentRegistries)
      .where(eq(agentRegistries.userId, userId))
      .limit(1);

    if (existing) {
      throw new Error(
        `User ${userId} already registered as agent ${existing.agentId}`,
      );
    }

    const registryId = `agent-user-${userId}`;
    const capabilityId = `cap-${userId}`;

    // Create registry entry
    await db.insert(agentRegistries).values({
      id: registryId,
      agentId: userId,
      type: AgentType.USER_CONTROLLED,
      status: AgentStatus.REGISTERED,
      trustLevel,
      userId,
      name,
      systemPrompt,
      // Discovery metadata
      discoveryAuthRequired: false,
      discoveryAuthMethods: [],
      updatedAt: new Date(),
    });

    // Create capabilities
    await db.insert(agentCapabilities).values({
      id: capabilityId,
      agentRegistryId: registryId,
      strategies: capabilities.strategies ?? [],
      markets: capabilities.markets ?? [],
      actions: capabilities.actions ?? [],
      version: capabilities.version ?? "1.0.0",
      x402Support: capabilities.x402Support ?? false,
      platform: capabilities.platform,
      userType: capabilities.userType,
      gameNetworkChainId: capabilities.gameNetwork?.chainId,
      gameNetworkRpcUrl: capabilities.gameNetwork?.registryAddress,
      gameNetworkExplorerUrl: capabilities.gameNetwork?.reputationAddress,
      // OASF Taxonomy Support (Agent0 SDK v0.31.0)
      skills: capabilities.skills ?? [],
      domains: capabilities.domains ?? [],
      // A2A Communication Endpoints (Agent0 SDK v0.31.0)
      a2aEndpoint: capabilities.a2aEndpoint,
      mcpEndpoint: capabilities.mcpEndpoint,
      updatedAt: new Date(),
    });

    // Fetch complete registry with relations
    const registry = await this.getRegistryWithRelations(userId);
    if (!registry) {
      throw new Error("Failed to create agent registry");
    }

    return this.mapToRegistration(registry);
  }

  /**
   * Register an NPC agent from Actor record
   *
   * @description Creates registry entry linked to existing Actor. Verifies actor exists
   * and is not already registered. Creates registry entry with NPC type and SYSTEM trust level.
   *
   * @param {object} params - Registration parameters
   * @param {string} params.actorId - Actor ID
   * @param {string} params.systemPrompt - System prompt
   * @param {AgentCapabilities} params.capabilities - Agent capabilities
   * @returns {Promise<AgentRegistration>} Registered agent
   * @throws {Error} If actor not found or already registered
   */
  async registerNpcAgent(params: {
    actorId: string;
    systemPrompt: string;
    capabilities: AgentCapabilities;
  }): Promise<AgentRegistration> {
    const { actorId, systemPrompt, capabilities } = params;

    // NPC support removed - throw error
    throw new Error(
      `NPC registration not supported. Use registerUserAgent instead.`,
    );

    // Check if already registered
    const [existing] = await db
      .select()
      .from(agentRegistries)
      .where(eq(agentRegistries.actorId, actorId))
      .limit(1);

    if (existing) {
      throw new Error(
        `Actor ${actorId} already registered as agent ${existing.agentId}`,
      );
    }

    const registryId = `agent-npc-${actorId}`;
    const capabilityId = `cap-${actorId}`;

    // Create registry entry with SYSTEM trust level for NPCs
    await db.insert(agentRegistries).values({
      id: registryId,
      agentId: actorId,
      type: AgentType.NPC,
      status: AgentStatus.REGISTERED,
      trustLevel: 4, // SYSTEM trust level for NPCs
      actorId,
      name: actor.name,
      systemPrompt,
      discoveryAuthRequired: false,
      discoveryAuthMethods: [],
      updatedAt: new Date(),
    });

    // Create capabilities
    await db.insert(agentCapabilities).values({
      id: capabilityId,
      agentRegistryId: registryId,
      strategies: capabilities.strategies ?? [],
      markets: capabilities.markets ?? [],
      actions: capabilities.actions ?? [],
      version: capabilities.version ?? "1.0.0",
      x402Support: capabilities.x402Support ?? false,
      platform: capabilities.platform,
      userType: capabilities.userType,
      gameNetworkChainId: capabilities.gameNetwork?.chainId,
      gameNetworkRpcUrl: capabilities.gameNetwork?.registryAddress,
      gameNetworkExplorerUrl: capabilities.gameNetwork?.reputationAddress,
      skills: capabilities.skills ?? [],
      domains: capabilities.domains ?? [],
      a2aEndpoint: capabilities.a2aEndpoint,
      mcpEndpoint: capabilities.mcpEndpoint,
      updatedAt: new Date(),
    });

    // Fetch complete registry with relations
    const registry = await this.getRegistryWithRelations(actorId);
    if (!registry) {
      throw new Error("Failed to create agent registry");
    }

    return this.mapToRegistration(registry);
  }

  /**
   * Register an EXTERNAL agent (ElizaOS, MCP, Agent0, custom)
   *
   * @description Creates registry entry with connection parameters for external agents.
   * Verifies external agent is not already registered. Creates registry entry with EXTERNAL
   * type and UNTRUSTED trust level by default.
   *
   * @param {ExternalAgentConnectionParams} params - External agent connection parameters
   * @returns {Promise<AgentRegistration>} Registered agent
   * @throws {Error} If external agent already registered
   */
  async registerExternalAgent(
    params: ExternalAgentConnectionParams,
  ): Promise<AgentRegistration> {
    const {
      externalId,
      name,
      description,
      endpoint,
      protocol,
      capabilities,
      authentication,
      agentCard,
      registeredByUserId,
    } = params;

    // Check if already registered
    const [existing] = await db
      .select()
      .from(externalAgentConnections)
      .where(eq(externalAgentConnections.externalId, externalId))
      .limit(1);

    if (existing) {
      throw new Error(`External agent already registered: ${externalId}`);
    }

    const registryId = `agent-ext-${externalId}`;
    const capabilityId = `cap-${externalId}`;
    const connectionId = `ext-conn-${externalId}`;

    // Create registry entry with UNTRUSTED trust level by default
    await db.insert(agentRegistries).values({
      id: registryId,
      agentId: externalId,
      type: AgentType.EXTERNAL,
      status: AgentStatus.REGISTERED,
      trustLevel: 0, // UNTRUSTED by default, must be verified
      name,
      systemPrompt: description,
      // Discovery metadata from Agent Card
      discoveryCardVersion: agentCard?.version,
      discoveryEndpointA2a: agentCard?.endpoints?.a2a,
      discoveryEndpointMcp: agentCard?.endpoints?.mcp,
      discoveryEndpointRpc: agentCard?.endpoints?.rpc,
      discoveryAuthRequired: agentCard?.authentication?.required ?? false,
      discoveryAuthMethods: agentCard?.authentication?.methods ?? [],
      discoveryRateLimit: agentCard?.limits?.rateLimit,
      discoveryCostPerAction: agentCard?.limits?.costPerAction,
      updatedAt: new Date(),
    });

    // Create capabilities
    await db.insert(agentCapabilities).values({
      id: capabilityId,
      agentRegistryId: registryId,
      strategies: capabilities.strategies ?? [],
      markets: capabilities.markets ?? [],
      actions: capabilities.actions ?? [],
      version: capabilities.version ?? "1.0.0",
      x402Support: capabilities.x402Support ?? false,
      platform: capabilities.platform,
      userType: capabilities.userType,
      gameNetworkChainId: capabilities.gameNetwork?.chainId,
      gameNetworkRpcUrl: capabilities.gameNetwork?.registryAddress,
      gameNetworkExplorerUrl: capabilities.gameNetwork?.reputationAddress,
      skills: capabilities.skills ?? [],
      domains: capabilities.domains ?? [],
      a2aEndpoint: capabilities.a2aEndpoint,
      mcpEndpoint: capabilities.mcpEndpoint,
      updatedAt: new Date(),
    });

    // Create external connection
    await db.insert(externalAgentConnections).values({
      id: connectionId,
      agentRegistryId: registryId,
      externalId,
      endpoint,
      protocol,
      authType: authentication?.type,
      authCredentials: authentication?.credentials
        ? this.encryptCredentials(authentication.credentials)
        : null,
      // AgentCard is structurally compatible with JsonValue - all fields are JsonValue types
      // (strings, numbers, booleans, objects, arrays - all JsonValue-compatible)
      agentCardJson: agentCard
        ? (JSON.parse(JSON.stringify(agentCard)) as JsonValue)
        : null,
      registeredByUserId,
      updatedAt: new Date(),
    });

    // Fetch complete registry with relations
    const registry = await this.getRegistryWithRelations(externalId);
    if (!registry) {
      throw new Error("Failed to create agent registry");
    }

    return this.mapToRegistration(registry);
  }

  /**
   * Discover agents using flexible filters
   *
   * @description Supports querying by type, status, trust level, capabilities,
   * OASF skills/domains. Returns paginated results ordered by trust level and registration date.
   *
   * @param {AgentDiscoveryFilter} [filter={}] - Discovery filter options
   * @returns {Promise<AgentRegistration[]>} Array of matching agents
   */
  async discoverAgents(
    filter: AgentDiscoveryFilter = {},
  ): Promise<AgentRegistration[]> {
    const {
      types,
      statuses,
      minTrustLevel,
      requiredCapabilities,
      requiredSkills,
      requiredDomains,
      matchMode = "all",
      search,
      limit = 50,
      offset = 0,
    } = filter;

    // Build where conditions
    const conditions = [];

    if (types && types.length > 0) {
      conditions.push(inArray(agentRegistries.type, types));
    }

    if (statuses && statuses.length > 0) {
      conditions.push(inArray(agentRegistries.status, statuses));
    }

    if (minTrustLevel !== undefined) {
      conditions.push(gte(agentRegistries.trustLevel, minTrustLevel));
    }

    if (search) {
      const searchCondition = or(
        ilike(agentRegistries.name, `%${search}%`),
        ilike(agentRegistries.systemPrompt, `%${search}%`),
      );
      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }

    const registrationsRaw = await db
      .select()
      .from(agentRegistries)
      .leftJoin(
        agentCapabilities,
        eq(agentCapabilities.agentRegistryId, agentRegistries.id),
      )
      .leftJoin(users, eq(users.id, agentRegistries.userId))
      .leftJoin(
        externalAgentConnections,
        eq(externalAgentConnections.agentRegistryId, agentRegistries.id),
      )
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(
        desc(agentRegistries.trustLevel),
        desc(agentRegistries.registeredAt),
      )
      .limit(limit)
      .offset(offset);

    // Map to registry with relations format, getting Actor from static registry
    const registrations: RegistryWithRelations[] = registrationsRaw.map(
      (row) => {
        const _actorId = row.AgentRegistry.actorId;
        const staticActor = null; // NPC support removed
        return {
          ...row.AgentRegistry,
          capabilities: row.AgentCapability,
          User: row.User,
          Actor: staticActor,
          externalConnection: row.ExternalAgentConnection,
        };
      },
    );

    // Filter by required capabilities if specified
    let filtered = registrations;
    if (requiredCapabilities && requiredCapabilities.length > 0) {
      filtered = filtered.filter((reg) => {
        if (!reg.capabilities) return false;
        const allCaps = [
          ...(reg.capabilities.strategies || []),
          ...(reg.capabilities.markets || []),
          ...(reg.capabilities.actions || []),
        ];
        return requiredCapabilities.every((cap) => allCaps.includes(cap));
      });
    }

    // Filter by OASF skills if specified (Agent0 SDK v0.31.0)
    if (requiredSkills && requiredSkills.length > 0) {
      filtered = filtered.filter((reg) => {
        if (!reg.capabilities || !reg.capabilities.skills) return false;
        const agentSkills = reg.capabilities.skills;

        if (matchMode === "all") {
          // All required skills must be present
          return requiredSkills.every((skill) => agentSkills.includes(skill));
        }
        // Any required skill matches
        return requiredSkills.some((skill) => agentSkills.includes(skill));
      });
    }

    // Filter by OASF domains if specified (Agent0 SDK v0.31.0)
    if (requiredDomains && requiredDomains.length > 0) {
      filtered = filtered.filter((reg) => {
        if (!reg.capabilities || !reg.capabilities.domains) return false;
        const agentDomains = reg.capabilities.domains;

        if (matchMode === "all") {
          // All required domains must be present
          return requiredDomains.every((domain) =>
            agentDomains.includes(domain),
          );
        }
        // Any required domain matches
        return requiredDomains.some((domain) => agentDomains.includes(domain));
      });
    }

    return filtered.map((reg) => this.mapToRegistration(reg));
  }

  /**
   * Get agent by agentId
   *
   * @description Gets agent by agentId (userId for USER_CONTROLLED, actorId for NPC,
   * externalId for EXTERNAL). Returns null if not found.
   *
   * @param {string} agentId - Agent ID
   * @returns {Promise<AgentRegistration | null>} Agent registration or null
   */
  async getAgentById(agentId: string): Promise<AgentRegistration | null> {
    const registry = await this.getRegistryWithRelations(agentId);

    if (!registry) return null;

    return this.mapToRegistration(registry);
  }

  /**
   * Update agent status
   *
   * @description Updates agent status in lifecycle: REGISTERED → INITIALIZED → ACTIVE → PAUSED → TERMINATED.
   * Updates lastActiveAt for ACTIVE status and terminatedAt for TERMINATED status.
   *
   * @param {string} agentId - Agent ID
   * @param {AgentStatus} status - New status
   * @returns {Promise<AgentRegistration>} Updated agent registration
   */
  async updateAgentStatus(
    agentId: string,
    status: AgentStatus,
  ): Promise<AgentRegistration> {
    await db
      .update(agentRegistries)
      .set({
        status,
        lastActiveAt: status === AgentStatus.ACTIVE ? new Date() : undefined,
        terminatedAt:
          status === AgentStatus.TERMINATED ? new Date() : undefined,
      })
      .where(eq(agentRegistries.agentId, agentId));

    const registry = await this.getRegistryWithRelations(agentId);
    if (!registry) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    return this.mapToRegistration(registry);
  }

  /**
   * Set runtime instance ID when AgentRuntime is created
   *
   * @description Sets runtime instance ID and updates status to INITIALIZED when
   * AgentRuntime is created.
   *
   * @param {string} agentId - Agent ID
   * @param {string} runtimeInstanceId - Runtime instance ID
   * @returns {Promise<void>}
   */
  async setRuntimeInstance(
    agentId: string,
    runtimeInstanceId: string,
  ): Promise<void> {
    await db
      .update(agentRegistries)
      .set({
        runtimeInstanceId,
        status: AgentStatus.INITIALIZED,
      })
      .where(eq(agentRegistries.agentId, agentId));
  }

  /**
   * Clear runtime instance ID when AgentRuntime is destroyed
   *
   * @description Clears runtime instance ID and updates status to REGISTERED when
   * AgentRuntime is destroyed.
   *
   * @param {string} agentId - Agent ID
   * @returns {Promise<void>}
   */
  async clearRuntimeInstance(agentId: string): Promise<void> {
    await db
      .update(agentRegistries)
      .set({
        runtimeInstanceId: null,
        status: AgentStatus.REGISTERED,
      })
      .where(eq(agentRegistries.agentId, agentId));
  }

  /**
   * Update trust level
   *
   * @description Updates agent trust level. Requires verification before calling.
   *
   * @param {string} agentId - Agent ID
   * @param {TrustLevel} trustLevel - New trust level
   * @returns {Promise<void>}
   */
  async updateTrustLevel(
    agentId: string,
    trustLevel: TrustLevel,
  ): Promise<void> {
    await db
      .update(agentRegistries)
      .set({ trustLevel })
      .where(eq(agentRegistries.agentId, agentId));
  }

  /**
   * Link external agent to User account
   *
   * @description Allows EXTERNAL agents to gain USER_CONTROLLED capabilities after verification.
   * Verifies agent is EXTERNAL type and user is not already linked to another agent.
   * Updates trust level to at least BASIC when linked.
   *
   * @param {string} agentId - External agent ID
   * @param {string} userId - User ID to link
   * @returns {Promise<AgentRegistration>} Updated agent registration
   * @throws {Error} If agent not found, not EXTERNAL type, user not found, or user already linked
   */
  async linkExternalAgentToUser(
    agentId: string,
    userId: string,
  ): Promise<AgentRegistration> {
    // Verify agent is EXTERNAL type
    const [registry] = await db
      .select()
      .from(agentRegistries)
      .where(eq(agentRegistries.agentId, agentId))
      .limit(1);

    if (!registry) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    if (registry.type !== AgentType.EXTERNAL) {
      throw new Error(
        `Only EXTERNAL agents can be linked to users. Agent ${agentId} is type ${registry.type}`,
      );
    }

    // Verify user exists and not already linked to another agent
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    const [existingAgentRegistry] = await db
      .select()
      .from(agentRegistries)
      .where(eq(agentRegistries.userId, userId))
      .limit(1);

    if (existingAgentRegistry) {
      throw new Error(
        `User ${userId} already linked to agent ${existingAgentRegistry.agentId}`,
      );
    }

    // Link external agent to user
    await db
      .update(agentRegistries)
      .set({
        userId,
        trustLevel: Math.max(registry.trustLevel, 1), // At least BASIC trust when linked
      })
      .where(eq(agentRegistries.agentId, agentId));

    const updated = await this.getRegistryWithRelations(agentId);
    if (!updated) {
      throw new Error(`Failed to update agent: ${agentId}`);
    }

    return this.mapToRegistration(updated);
  }

  /**
   * Verify external agent API key
   *
   * @description Verifies an API key against registered external agents.
   * Decrypts stored credentials and checks hash.
   *
   * @param {string} apiKey - API key to verify
   * @returns {Promise<AgentRegistration | null>} Agent registration if valid, null otherwise
   */
  async verifyExternalAgentApiKey(
    apiKey: string,
  ): Promise<AgentRegistration | null> {
    const agents = await db
      .select()
      .from(externalAgentConnections)
      .where(
        and(
          eq(externalAgentConnections.authType, "apiKey"),
          isNull(externalAgentConnections.revokedAt),
        ),
      );

    for (const agent of agents) {
      if (!agent.authCredentials) continue;

      // Decrypt and verify credentials - continue to next agent if this one fails
      let credentials: { apiKeyHash?: string } | undefined;
      try {
        const decrypted = this.decryptCredentials(agent.authCredentials);
        credentials = JSON.parse(decrypted) as { apiKeyHash?: string };
      } catch (error) {
        logger.warn(
          `Failed to parse auth credentials for external agent ${agent.externalId}`,
          {
            externalId: agent.externalId,
            error: error instanceof Error ? error.message : String(error),
          },
          "AgentRegistryService",
        );
        continue;
      }

      if (
        credentials?.apiKeyHash &&
        verifyApiKey(apiKey, credentials.apiKeyHash)
      ) {
        const registry = await this.getRegistryWithRelations(agent.externalId);
        if (!registry) {
          logger.warn(
            `Valid key for external agent ${agent.externalId} but missing AgentRegistry link`,
            undefined,
            "AgentRegistryService",
          );
          return null;
        }
        return this.mapToRegistration(registry);
      }
    }

    return null;
  }

  /**
   * Revoke an external agent's API key
   *
   * @description Sets the revokedAt timestamp and revokedBy user ID on an external agent connection.
   * After revocation, the agent's API key will no longer be valid for authentication.
   *
   * @param {string} externalId - External agent ID
   * @param {string} revokedBy - User ID of the person revoking the agent
   * @returns {Promise<void>}
   * @throws {Error} If agent not found or already revoked
   */
  async revokeExternalAgent(
    externalId: string,
    revokedBy: string,
  ): Promise<void> {
    const now = new Date();
    const [updated] = await db
      .update(externalAgentConnections)
      .set({
        revokedAt: now,
        revokedBy,
        updatedAt: now,
      })
      .where(
        and(
          eq(externalAgentConnections.externalId, externalId),
          isNull(externalAgentConnections.revokedAt),
        ),
      )
      .returning({ externalId: externalAgentConnections.externalId });

    if (!updated) {
      const [agent] = await db
        .select({ revokedAt: externalAgentConnections.revokedAt })
        .from(externalAgentConnections)
        .where(eq(externalAgentConnections.externalId, externalId))
        .limit(1);

      if (!agent) {
        throw new Error(`External agent not found: ${externalId}`);
      }

      throw new Error(`External agent already revoked: ${externalId}`);
    }

    // Log the revocation event
    logger.info(
      `External agent ${externalId} revoked by ${revokedBy}`,
      { externalId, revokedBy },
      "AgentRegistryService",
    );
  }

  /**
   * Get external agent connection by externalId
   *
   * @description Retrieves the external agent connection record including revocation status.
   *
   * @param {string} externalId - External agent ID
   * @returns {Promise<ExternalAgentConnection | null>} External agent connection or null
   */
  async getExternalAgentConnection(
    externalId: string,
  ): Promise<ExternalAgentConnection | null> {
    const [agent] = await db
      .select()
      .from(externalAgentConnections)
      .where(eq(externalAgentConnections.externalId, externalId))
      .limit(1);

    return agent ?? null;
  }

  /**
   * Helper method to get registry with all relations
   */
  private async getRegistryWithRelations(
    agentId: string,
  ): Promise<RegistryWithRelations | null> {
    const [row] = await db
      .select()
      .from(agentRegistries)
      .leftJoin(
        agentCapabilities,
        eq(agentCapabilities.agentRegistryId, agentRegistries.id),
      )
      .leftJoin(users, eq(users.id, agentRegistries.userId))
      .leftJoin(
        externalAgentConnections,
        eq(externalAgentConnections.agentRegistryId, agentRegistries.id),
      )
      .where(eq(agentRegistries.agentId, agentId))
      .limit(1);

    if (!row) return null;

    // NPC support removed
    const _actorId = row.AgentRegistry.actorId;
    const staticActor = null;

    return {
      ...row.AgentRegistry,
      capabilities: row.AgentCapability,
      User: row.User,
      Actor: staticActor,
      externalConnection: row.ExternalAgentConnection,
    };
  }

  /**
   * Map database model to AgentRegistration type
   *
   * @description Maps Drizzle AgentRegistry model with relations to AgentRegistration
   * type. Handles capabilities, discovery metadata, on-chain data, and Agent0 data mapping.
   *
   * @param {RegistryWithRelations} registry - Registry with relations
   * @returns {AgentRegistration} Agent registration
   * @private
   */
  private mapToRegistration(
    registry: RegistryWithRelations,
  ): AgentRegistration {
    // Map capabilities
    const capabilities: AgentCapabilities = registry.capabilities
      ? {
          strategies: registry.capabilities.strategies,
          markets: registry.capabilities.markets,
          actions: registry.capabilities.actions,
          version: registry.capabilities.version,
          x402Support: registry.capabilities.x402Support,
          platform: registry.capabilities.platform ?? undefined,
          userType: registry.capabilities.userType ?? undefined,
          gameNetwork: registry.capabilities.gameNetworkChainId
            ? {
                chainId: registry.capabilities.gameNetworkChainId,
                registryAddress:
                  registry.capabilities.gameNetworkRpcUrl ||
                  "0x0000000000000000000000000000000000000000", // A2A: registryAddress read from rpcUrl field, fallback to zero address
                reputationAddress:
                  registry.capabilities.gameNetworkExplorerUrl ?? undefined, // A2A: reputationAddress read from explorerUrl field
              }
            : undefined,
          // OASF Taxonomy Support (Agent0 SDK v0.31.0)
          skills: registry.capabilities.skills,
          domains: registry.capabilities.domains,
          // A2A Communication Endpoints (Agent0 SDK v0.31.0)
          a2aEndpoint: registry.capabilities.a2aEndpoint ?? undefined,
          mcpEndpoint: registry.capabilities.mcpEndpoint ?? undefined,
        }
      : {
          strategies: [],
          markets: [],
          actions: [],
          version: "1.0.0",
          x402Support: false,
          skills: [],
          domains: [],
        };

    return {
      agentId: registry.agentId,
      type: registry.type as AgentType,
      status: registry.status as AgentStatus,
      trustLevel: registry.trustLevel as TrustLevel,
      userId: registry.userId,
      name: registry.name,
      systemPrompt: registry.systemPrompt,
      capabilities,
      discoveryMetadata: registry.discoveryCardVersion
        ? {
            version: "1.0" as const,
            agentId: registry.agentId,
            name: registry.name,
            description: registry.systemPrompt,
            endpoints: {
              a2a: registry.discoveryEndpointA2a ?? undefined,
              mcp: registry.discoveryEndpointMcp ?? undefined,
              rpc: registry.discoveryEndpointRpc ?? undefined,
            },
            capabilities,
            authentication: registry.discoveryAuthRequired
              ? {
                  required: true,
                  methods: registry.discoveryAuthMethods as (
                    | "apiKey"
                    | "oauth"
                    | "wallet"
                  )[],
                }
              : undefined,
            limits: registry.discoveryRateLimit
              ? {
                  rateLimit: registry.discoveryRateLimit,
                  costPerAction: registry.discoveryCostPerAction ?? undefined,
                }
              : undefined,
          }
        : null,
      onChainData: registry.onChainTokenId
        ? {
            tokenId: registry.onChainTokenId,
            txHash: registry.onChainTxHash ?? "",
            serverWallet: registry.onChainServerWallet ?? "",
            reputationScore: registry.onChainReputationScore ?? 0,
            chainId: registry.onChainChainId ?? 31337,
            contracts: {
              identityRegistry: registry.onChainIdentityRegistry ?? "",
              reputationSystem: registry.onChainReputationSystem ?? "",
            },
          }
        : null,
      agent0Data: registry.agent0TokenId
        ? {
            tokenId: registry.agent0TokenId,
            metadataCID: registry.agent0MetadataCID ?? "",
            subgraphData: registry.agent0SubgraphOwner
              ? {
                  owner: registry.agent0SubgraphOwner,
                  metadataURI: registry.agent0SubgraphMetadataURI ?? "",
                  timestamp: registry.agent0SubgraphTimestamp ?? 0,
                }
              : undefined,
            discoveryEndpoint: registry.agent0DiscoveryEndpoint ?? "",
          }
        : null,
      runtimeInstanceId: registry.runtimeInstanceId,
      registeredAt: registry.registeredAt,
      lastActiveAt: registry.lastActiveAt,
      terminatedAt: registry.terminatedAt,
    };
  }

  /**
   * Encrypt credentials for secure storage
   * Uses AES-256-CBC encryption with random IV
   */
  private encryptCredentials(credentials: string): string {
    const iv = randomBytes(16);
    const key = Buffer.from(getEncryptionKey().padEnd(32).slice(0, 32));
    const cipher = createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(credentials, "utf8", "hex");
    encrypted += cipher.final("hex");

    return `${iv.toString("hex")}:${encrypted}`;
  }

  /**
   * Decrypt credentials
   */
  private decryptCredentials(encrypted: string): string {
    const [ivHex, encryptedHex] = encrypted.split(":");
    if (!ivHex || !encryptedHex) throw new Error("Invalid encrypted format");

    const iv = Buffer.from(ivHex, "hex");
    const key = Buffer.from(getEncryptionKey().padEnd(32).slice(0, 32));
    const decipher = createDecipheriv(ALGORITHM, key, iv);

    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  }
}

// Export singleton instance
export const agentRegistry = new AgentRegistryService();
