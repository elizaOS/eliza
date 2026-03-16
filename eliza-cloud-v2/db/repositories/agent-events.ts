import { eq, desc, and, gte, sql, inArray } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  agentEvents,
  type AgentEvent,
  type NewAgentEvent,
  type AgentEventType,
  type AgentLogLevel,
} from "../schemas/agent-events";

export type { AgentEvent, NewAgentEvent, AgentEventType, AgentLogLevel };

export interface AgentEventFilters {
  eventTypes?: AgentEventType[];
  levels?: AgentLogLevel[];
  since?: Date;
  limit?: number;
}

export class AgentEventsRepository {
  // ============================================================================
  // READ OPERATIONS (use read replica)
  // ============================================================================

  async findById(id: string): Promise<AgentEvent | undefined> {
    return await dbRead.query.agentEvents.findFirst({
      where: eq(agentEvents.id, id),
    });
  }

  async listByAgent(
    agentId: string,
    filters?: AgentEventFilters,
  ): Promise<AgentEvent[]> {
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

    return await dbRead.query.agentEvents.findMany({
      where: and(...conditions),
      orderBy: desc(agentEvents.created_at),
      limit: filters?.limit || 50,
    });
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

    return await dbRead.query.agentEvents.findMany({
      where: and(...conditions),
      orderBy: desc(agentEvents.created_at),
      limit: filters?.limit || 100,
    });
  }

  async getLatestByAgent(
    agentId: string,
    eventType?: AgentEventType,
  ): Promise<AgentEvent | undefined> {
    const conditions = [eq(agentEvents.agent_id, agentId)];

    if (eventType) {
      conditions.push(eq(agentEvents.event_type, eventType));
    }

    return await dbRead.query.agentEvents.findFirst({
      where: and(...conditions),
      orderBy: desc(agentEvents.created_at),
    });
  }

  async getLatestError(agentId: string): Promise<AgentEvent | undefined> {
    return await dbRead.query.agentEvents.findFirst({
      where: and(
        eq(agentEvents.agent_id, agentId),
        eq(agentEvents.level, "error"),
      ),
      orderBy: desc(agentEvents.created_at),
    });
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
  // WRITE OPERATIONS (use NA primary)
  // ============================================================================

  async create(data: NewAgentEvent): Promise<AgentEvent> {
    const [event] = await dbWrite.insert(agentEvents).values(data).returning();
    return event;
  }

  async createMany(data: NewAgentEvent[]): Promise<AgentEvent[]> {
    if (data.length === 0) return [];
    return await dbWrite.insert(agentEvents).values(data).returning();
  }

  async deleteOlderThan(days: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const result = await dbWrite
      .delete(agentEvents)
      .where(sql`${agentEvents.created_at} < ${cutoff}`);

    return result.rowCount || 0;
  }
}

export const agentEventsRepository = new AgentEventsRepository();
