import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { ObjectNamespaces } from "@/lib/storage/object-namespace";
import {
  hydrateJsonField,
  hydrateTextField,
  offloadJsonField,
  offloadTextField,
} from "@/lib/storage/object-store";
import { mutateRowCount } from "../execute-helpers";
import { dbRead, dbWrite } from "../helpers";
import {
  type AgentEvent,
  type AgentEventType,
  type AgentLogLevel,
  agentEvents,
  type NewAgentEvent,
} from "../schemas/agent-events";

export type { AgentEvent, AgentEventType, AgentLogLevel, NewAgentEvent };

export interface AgentEventFilters {
  eventTypes?: AgentEventType[];
  levels?: AgentLogLevel[];
  since?: Date;
  limit?: number;
}

async function hydrateAgentEvent(event: AgentEvent): Promise<AgentEvent> {
  const [message, metadata] = await Promise.all([
    hydrateTextField({
      storage: event.message_storage,
      key: event.message_key,
      inlineValue: event.message,
    }),
    hydrateJsonField<Record<string, unknown>>({
      storage: event.metadata_storage,
      key: event.metadata_key,
      inlineValue: event.metadata,
    }),
  ]);

  return {
    ...event,
    message: message ?? "",
    metadata: metadata ?? {},
  };
}

async function prepareAgentEventPayload(data: NewAgentEvent): Promise<NewAgentEvent> {
  if (data.message_storage === "r2" || data.metadata_storage === "r2") {
    return data;
  }

  const id = data.id ?? randomUUID();
  const createdAt = data.created_at ?? new Date();
  const [message, metadata] = await Promise.all([
    offloadTextField({
      namespace: ObjectNamespaces.AgentEventBodies,
      organizationId: data.organization_id,
      objectId: id,
      field: "message",
      createdAt,
      value: data.message,
    }),
    offloadJsonField<Record<string, unknown>>({
      namespace: ObjectNamespaces.AgentEventBodies,
      organizationId: data.organization_id,
      objectId: id,
      field: "metadata",
      createdAt,
      value: data.metadata,
      inlineValueWhenOffloaded: {},
    }),
  ]);

  return {
    ...data,
    id,
    created_at: createdAt,
    message: message.value ?? "",
    message_storage: message.storage,
    message_key: message.key,
    metadata: metadata.value ?? {},
    metadata_storage: metadata.storage,
    metadata_key: metadata.key,
  };
}

export class AgentEventsRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  async findById(id: string): Promise<AgentEvent | undefined> {
    const event = await dbRead.query.agentEvents.findFirst({
      where: eq(agentEvents.id, id),
    });
    return event ? await hydrateAgentEvent(event) : undefined;
  }

  async listByAgent(agentId: string, filters?: AgentEventFilters): Promise<AgentEvent[]> {
    const conditions = [eq(agentEvents.agent_id, agentId)];

    if (filters?.eventTypes && filters.eventTypes.length > 0) {
      conditions.push(inArray(agentEvents.event_type, filters.eventTypes));
    }

    if (filters?.levels && filters.levels.length > 0) {
      conditions.push(inArray(agentEvents.level, filters.levels));
    }

    if (filters?.since) {
      conditions.push(gte(agentEvents.created_at, filters.since));
    }

    const rows = await dbRead.query.agentEvents.findMany({
      where: and(...conditions),
      orderBy: desc(agentEvents.created_at),
      limit: filters?.limit || 50,
    });
    return await Promise.all(rows.map(hydrateAgentEvent));
  }

  async listByOrganization(
    organizationId: string,
    filters?: AgentEventFilters,
  ): Promise<AgentEvent[]> {
    const conditions = [eq(agentEvents.organization_id, organizationId)];

    if (filters?.eventTypes && filters.eventTypes.length > 0) {
      conditions.push(inArray(agentEvents.event_type, filters.eventTypes));
    }

    if (filters?.levels && filters.levels.length > 0) {
      conditions.push(inArray(agentEvents.level, filters.levels));
    }

    if (filters?.since) {
      conditions.push(gte(agentEvents.created_at, filters.since));
    }

    const rows = await dbRead.query.agentEvents.findMany({
      where: and(...conditions),
      orderBy: desc(agentEvents.created_at),
      limit: filters?.limit || 100,
    });
    return await Promise.all(rows.map(hydrateAgentEvent));
  }

  async getLatestByAgent(
    agentId: string,
    eventType?: AgentEventType,
  ): Promise<AgentEvent | undefined> {
    const conditions = [eq(agentEvents.agent_id, agentId)];

    if (eventType) {
      conditions.push(eq(agentEvents.event_type, eventType));
    }

    const event = await dbRead.query.agentEvents.findFirst({
      where: and(...conditions),
      orderBy: desc(agentEvents.created_at),
    });
    return event ? await hydrateAgentEvent(event) : undefined;
  }

  async getLatestError(agentId: string): Promise<AgentEvent | undefined> {
    const event = await dbRead.query.agentEvents.findFirst({
      where: and(eq(agentEvents.agent_id, agentId), eq(agentEvents.level, "error")),
      orderBy: desc(agentEvents.created_at),
    });
    return event ? await hydrateAgentEvent(event) : undefined;
  }

  async countByAgent(
    agentId: string,
    since?: Date,
  ): Promise<{ total: number; byType: Record<string, number> }> {
    const conditions = [eq(agentEvents.agent_id, agentId)];
    if (since) {
      conditions.push(gte(agentEvents.created_at, since));
    }

    const [countResult] = await dbRead
      .select({
        total: sql<number>`count(*)::int`,
      })
      .from(agentEvents)
      .where(and(...conditions));

    const typeBreakdown = await dbRead
      .select({
        eventType: agentEvents.event_type,
        count: sql<number>`count(*)::int`,
      })
      .from(agentEvents)
      .where(and(...conditions))
      .groupBy(agentEvents.event_type);

    const byType: Record<string, number> = {};
    for (const row of typeBreakdown) {
      byType[row.eventType] = row.count;
    }

    return {
      total: countResult?.total || 0,
      byType,
    };
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  async create(data: NewAgentEvent): Promise<AgentEvent> {
    const insertData = await prepareAgentEventPayload(data);
    const [event] = await dbWrite.insert(agentEvents).values(insertData).returning();
    return await hydrateAgentEvent(event);
  }

  async createMany(data: NewAgentEvent[]): Promise<AgentEvent[]> {
    if (data.length === 0) return [];
    const insertData = await Promise.all(data.map(prepareAgentEventPayload));
    const events = await dbWrite.insert(agentEvents).values(insertData).returning();
    return await Promise.all(events.map(hydrateAgentEvent));
  }

  async deleteOlderThan(days: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const result = await dbWrite
      .delete(agentEvents)
      .where(sql`${agentEvents.created_at} < ${cutoff}`);

    return mutateRowCount(result);
  }
}

export const agentEventsRepository = new AgentEventsRepository();
