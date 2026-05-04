import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { sqlRows } from "@/db/execute-helpers";
import {
  DISCORD_DEFAULT_INTENTS,
  type DiscordConnection,
  discordConnections,
} from "@/db/schemas/discord-connections";
import { getEncryptionService } from "@/lib/services/secrets/encryption";
import { logger } from "@/lib/utils/logger";

interface CreateConnectionInput {
  organizationId: string;
  characterId?: string;
  applicationId: string;
  botToken: string;
  intents?: number;
  metadata?: DiscordConnection["metadata"];
}

interface DecryptedAssignment {
  connectionId: string;
  organizationId: string;
  applicationId: string;
  botToken: string;
  intents: number;
  characterId: string | null;
}

/** Valid connection status values (matches migration CHECK constraint) */
type ConnectionStatus = "pending" | "connecting" | "connected" | "disconnected" | "error";

export const discordConnectionsRepository = {
  async create(input: CreateConnectionInput): Promise<DiscordConnection> {
    const encryption = getEncryptionService();
    const { encryptedValue, encryptedDek, nonce, authTag, keyId } = await encryption.encrypt(
      input.botToken,
    );

    const [connection] = await db
      .insert(discordConnections)
      .values({
        organization_id: input.organizationId,
        character_id: input.characterId,
        application_id: input.applicationId,
        bot_token_encrypted: encryptedValue,
        encrypted_dek: encryptedDek,
        token_nonce: nonce,
        token_auth_tag: authTag,
        encryption_key_id: keyId,
        intents: input.intents,
        metadata: input.metadata,
      })
      .returning();
    return connection;
  },

  async findById(id: string): Promise<DiscordConnection | null> {
    const [connection] = await db
      .select()
      .from(discordConnections)
      .where(eq(discordConnections.id, id))
      .limit(1);
    return connection ?? null;
  },

  async findByOrganizationId(organizationId: string): Promise<DiscordConnection[]> {
    return db
      .select()
      .from(discordConnections)
      .where(eq(discordConnections.organization_id, organizationId));
  },

  async findByApplicationId(
    organizationId: string,
    applicationId: string,
  ): Promise<DiscordConnection | null> {
    const [connection] = await db
      .select()
      .from(discordConnections)
      .where(
        and(
          eq(discordConnections.organization_id, organizationId),
          eq(discordConnections.application_id, applicationId),
        ),
      )
      .limit(1);
    return connection ?? null;
  },

  async findActiveUnassigned(): Promise<DiscordConnection[]> {
    return db
      .select()
      .from(discordConnections)
      .where(and(eq(discordConnections.is_active, true), isNull(discordConnections.assigned_pod)));
  },

  async findByAssignedPod(podName: string): Promise<DiscordConnection[]> {
    return db
      .select()
      .from(discordConnections)
      .where(
        and(eq(discordConnections.is_active, true), eq(discordConnections.assigned_pod, podName)),
      );
  },

  /**
   * Atomically assign an unassigned connection to a pod using row-level locking.
   * Prevents race conditions when multiple pods request assignments simultaneously.
   */
  async assignUnassignedToPod(podName: string): Promise<DiscordConnection | null> {
    // Use raw SQL for SELECT ... FOR UPDATE SKIP LOCKED
    const rows = await sqlRows<DiscordConnection>(
      db,
      sql`
      UPDATE discord_connections
      SET assigned_pod = ${podName},
          status = 'connecting',
          updated_at = NOW()
      WHERE id = (
        SELECT id FROM discord_connections
        WHERE is_active = true
          AND assigned_pod IS NULL
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `,
    );

    return rows[0] ?? null;
  },

  async updateStatus(
    connectionId: string,
    status: ConnectionStatus,
    podName: string,
    errorMessage?: string,
    botUserId?: string,
  ): Promise<DiscordConnection | null> {
    const updates: Partial<typeof discordConnections.$inferInsert> = {
      status,
      updated_at: new Date(),
    };

    if (errorMessage !== undefined) {
      updates.error_message = errorMessage;
    }

    if (status === "connected" || status === "connecting") {
      // Restore/maintain pod assignment on connect/reconnect
      updates.assigned_pod = podName;
      if (status === "connected") {
        updates.connected_at = new Date();
        // Store bot user ID for mention detection (different from application_id)
        if (botUserId) {
          updates.bot_user_id = botUserId;
        }
      }
    }

    // Clear error message for non-error states
    if (status !== "error" && errorMessage === undefined) {
      updates.error_message = null;
    }

    // Only clear pod assignment on "error" status
    // Don't clear on "disconnected" - the pod may reconnect shortly
    // Failover mechanism handles truly dead pods via heartbeat staleness
    if (status === "error") {
      updates.assigned_pod = null;
    }

    const [connection] = await db
      .update(discordConnections)
      .set(updates)
      .where(eq(discordConnections.id, connectionId))
      .returning();
    return connection ?? null;
  },

  async updateHeartbeat(connectionId: string): Promise<void> {
    await db
      .update(discordConnections)
      .set({
        last_heartbeat: new Date(),
        updated_at: new Date(),
      })
      .where(eq(discordConnections.id, connectionId));
  },

  /**
   * Batch update heartbeats for all connections assigned to a pod.
   * Returns the number of connections updated.
   */
  async updateHeartbeatBatch(podName: string, connectionIds: string[]): Promise<number> {
    if (connectionIds.length === 0) return 0;

    const result = await db
      .update(discordConnections)
      .set({
        last_heartbeat: new Date(),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(discordConnections.assigned_pod, podName),
          inArray(discordConnections.id, connectionIds),
        ),
      )
      .returning({ id: discordConnections.id });

    return result.length;
  },

  async updateStats(
    connectionId: string,
    stats: {
      guildCount?: number;
      eventsReceived?: number;
      eventsRouted?: number;
    },
  ): Promise<void> {
    const updates: Partial<typeof discordConnections.$inferInsert> = {
      updated_at: new Date(),
    };

    if (stats.guildCount !== undefined) {
      updates.guild_count = stats.guildCount;
    }
    if (stats.eventsReceived !== undefined) {
      updates.events_received = stats.eventsReceived;
    }
    if (stats.eventsRouted !== undefined) {
      updates.events_routed = stats.eventsRouted;
    }

    await db.update(discordConnections).set(updates).where(eq(discordConnections.id, connectionId));
  },

  /**
   * Check if a pod has any connections with a recent heartbeat.
   * Used to prevent false failover claims against healthy pods.
   */
  async hasRecentHeartbeat(podName: string, thresholdMs: number): Promise<boolean> {
    const cutoffTime = new Date(Date.now() - thresholdMs);
    const connections = await db
      .select({ id: discordConnections.id })
      .from(discordConnections)
      .where(
        and(
          eq(discordConnections.assigned_pod, podName),
          eq(discordConnections.is_active, true),
          sql`${discordConnections.last_heartbeat} > ${cutoffTime}`,
        ),
      )
      .limit(1);
    return connections.length > 0;
  },

  /**
   * Atomically reassign connections from a dead pod to a new pod.
   * Only reassigns connections with stale heartbeats to prevent TOCTOU race conditions.
   */
  async reassignFromDeadPod(
    deadPodName: string,
    newPodName: string,
    heartbeatThresholdMs: number = 45_000,
  ): Promise<number> {
    const cutoffTime = new Date(Date.now() - heartbeatThresholdMs);

    // Atomic update - only reassign if heartbeat is stale
    // This prevents race conditions where a "dead" pod comes back online
    const result = await db
      .update(discordConnections)
      .set({
        assigned_pod: newPodName,
        status: "connecting",
        updated_at: new Date(),
      })
      .where(
        and(
          eq(discordConnections.assigned_pod, deadPodName),
          eq(discordConnections.is_active, true),
          sql`(${discordConnections.last_heartbeat} IS NULL OR ${discordConnections.last_heartbeat} < ${cutoffTime})`,
        ),
      )
      .returning();
    return result.length;
  },

  async clearPodAssignments(podName: string): Promise<number> {
    const result = await db
      .update(discordConnections)
      .set({
        assigned_pod: null,
        status: "disconnected",
        updated_at: new Date(),
      })
      .where(eq(discordConnections.assigned_pod, podName))
      .returning();
    return result.length;
  },

  /**
   * Update a connection's fields.
   */
  async update(
    id: string,
    updates: Partial<typeof discordConnections.$inferInsert>,
  ): Promise<DiscordConnection> {
    const [connection] = await db
      .update(discordConnections)
      .set({
        ...updates,
        updated_at: new Date(),
      })
      .where(eq(discordConnections.id, id))
      .returning();
    return connection;
  },

  async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(discordConnections)
      .where(eq(discordConnections.id, id))
      .returning();
    return result.length > 0;
  },

  async deactivate(id: string): Promise<DiscordConnection | null> {
    const [connection] = await db
      .update(discordConnections)
      .set({
        is_active: false,
        assigned_pod: null,
        status: "disconnected",
        updated_at: new Date(),
      })
      .where(eq(discordConnections.id, id))
      .returning();
    return connection ?? null;
  },

  /**
   * Get assignments for a pod with decrypted bot tokens.
   * Optionally claims one unassigned connection for this pod.
   *
   * @param podName - The pod requesting assignments
   * @param claimNew - Whether to claim a new unassigned connection (default: true)
   *                   Set to false when pod is at capacity to prevent stuck assignments
   */
  async getAssignmentsForPod(podName: string, claimNew = true): Promise<DecryptedAssignment[]> {
    const encryption = getEncryptionService();

    // Only try to claim new connections if pod has capacity
    if (claimNew) {
      await this.assignUnassignedToPod(podName);
    }

    // Get all connections assigned to this pod
    const connections = await this.findByAssignedPod(podName);

    // Decrypt tokens in parallel
    const assignments = await Promise.all(
      connections.map(async (conn): Promise<DecryptedAssignment | null> => {
        try {
          const botToken = await encryption.decrypt({
            encryptedValue: conn.bot_token_encrypted,
            encryptedDek: conn.encrypted_dek,
            nonce: conn.token_nonce,
            authTag: conn.token_auth_tag,
          });

          return {
            connectionId: conn.id,
            organizationId: conn.organization_id,
            applicationId: conn.application_id,
            botToken,
            intents: conn.intents ?? DISCORD_DEFAULT_INTENTS,
            characterId: conn.character_id ?? null,
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error("[DiscordConnections] Failed to decrypt bot token", {
            connectionId: conn.id,
            error: errorMessage,
          });

          // Mark connection as error so it's not silently skipped
          // This makes decryption failures visible in monitoring
          // Wrap in try-catch to prevent db errors from failing all assignments
          try {
            await db
              .update(discordConnections)
              .set({
                status: "error",
                error_message: `Token decryption failed: ${errorMessage}`,
                assigned_pod: null, // Release for retry after key issue resolved
                updated_at: new Date(),
              })
              .where(eq(discordConnections.id, conn.id));
          } catch (dbError) {
            logger.error("[DiscordConnections] Failed to mark connection as error", {
              connectionId: conn.id,
              error: dbError instanceof Error ? dbError.message : String(dbError),
            });
          }

          return null;
        }
      }),
    );

    return assignments.filter((a): a is DecryptedAssignment => a !== null);
  },

  /**
   * Update a bot token (re-encrypts with new DEK).
   */
  async updateBotToken(
    connectionId: string,
    newBotToken: string,
  ): Promise<DiscordConnection | null> {
    const encryption = getEncryptionService();
    const { encryptedValue, encryptedDek, nonce, authTag, keyId } =
      await encryption.encrypt(newBotToken);

    const [connection] = await db
      .update(discordConnections)
      .set({
        bot_token_encrypted: encryptedValue,
        encrypted_dek: encryptedDek,
        token_nonce: nonce,
        token_auth_tag: authTag,
        encryption_key_id: keyId,
        updated_at: new Date(),
      })
      .where(eq(discordConnections.id, connectionId))
      .returning();

    return connection ?? null;
  },
};
