import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { dbWrite as db } from "@/db/client";
import {
  type NewSensitiveRequest,
  type NewSensitiveRequestEvent,
  type SensitiveRequest,
  type SensitiveRequestActorType,
  type SensitiveRequestAuditEventType,
  type SensitiveRequestEvent,
  type SensitiveRequestKind,
  type SensitiveRequestStatus,
  sensitiveRequestEvents,
  sensitiveRequests,
} from "@/db/schemas/sensitive-requests";

export interface SensitiveRequestWithEvents {
  request: SensitiveRequest;
  events: SensitiveRequestEvent[];
}

class SensitiveRequestsRepository {
  async create(data: NewSensitiveRequest): Promise<SensitiveRequest> {
    const [request] = await db.insert(sensitiveRequests).values(data).returning();
    return request;
  }

  async findById(id: string): Promise<SensitiveRequest | undefined> {
    const [request] = await db
      .select()
      .from(sensitiveRequests)
      .where(eq(sensitiveRequests.id, id))
      .limit(1);
    return request;
  }

  async findByTokenHash(tokenHash: string): Promise<SensitiveRequest | undefined> {
    const [request] = await db
      .select()
      .from(sensitiveRequests)
      .where(eq(sensitiveRequests.token_hash, tokenHash))
      .limit(1);
    return request;
  }

  async findWithEvents(id: string): Promise<SensitiveRequestWithEvents | undefined> {
    const request = await this.findById(id);
    if (!request) return undefined;
    return {
      request,
      events: await this.listEvents(id),
    };
  }

  async update(
    id: string,
    data: Partial<NewSensitiveRequest>,
  ): Promise<SensitiveRequest | undefined> {
    const [request] = await db
      .update(sensitiveRequests)
      .set({ ...data, updated_at: new Date() })
      .where(eq(sensitiveRequests.id, id))
      .returning();
    return request;
  }

  async transitionStatus(
    id: string,
    fromStatuses: SensitiveRequestStatus[],
    status: SensitiveRequestStatus,
    data: Partial<NewSensitiveRequest> = {},
  ): Promise<SensitiveRequest | undefined> {
    const [request] = await db
      .update(sensitiveRequests)
      .set({ ...data, status, updated_at: new Date() })
      .where(and(eq(sensitiveRequests.id, id), inArray(sensitiveRequests.status, fromStatuses)))
      .returning();
    return request;
  }

  async markTokenUsed(id: string): Promise<SensitiveRequest | undefined> {
    const [request] = await db
      .update(sensitiveRequests)
      .set({ token_used_at: new Date(), updated_at: new Date() })
      .where(and(eq(sensitiveRequests.id, id), isNull(sensitiveRequests.token_used_at)))
      .returning();
    return request;
  }

  async appendEvent(data: NewSensitiveRequestEvent): Promise<SensitiveRequestEvent> {
    const [event] = await db.insert(sensitiveRequestEvents).values(data).returning();
    return event;
  }

  async listEvents(requestId: string): Promise<SensitiveRequestEvent[]> {
    return db
      .select()
      .from(sensitiveRequestEvents)
      .where(eq(sensitiveRequestEvents.request_id, requestId))
      .orderBy(asc(sensitiveRequestEvents.created_at));
  }
}

export const sensitiveRequestsRepository = new SensitiveRequestsRepository();

export type {
  NewSensitiveRequest,
  NewSensitiveRequestEvent,
  SensitiveRequest,
  SensitiveRequestActorType,
  SensitiveRequestAuditEventType,
  SensitiveRequestEvent,
  SensitiveRequestKind,
  SensitiveRequestStatus,
};
