import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { ObjectNamespaces } from "@/lib/storage/object-namespace";
import { hydrateTextField, offloadTextField } from "@/lib/storage/object-store";
import { db } from "../client";
import {
  type NewSeoRequest,
  type SeoRequest,
  seoRequestStatusEnum,
  seoRequests,
} from "../schemas/seo";

export type { NewSeoRequest, SeoRequest };

async function hydrateSeoRequest(request: SeoRequest): Promise<SeoRequest> {
  const promptContext = await hydrateTextField({
    storage: request.prompt_context_storage,
    key: request.prompt_context_key,
    inlineValue: request.prompt_context,
  });

  return { ...request, prompt_context: promptContext };
}

async function prepareSeoRequestPayload<T extends NewSeoRequest | Partial<NewSeoRequest>>(
  data: T,
  context: Pick<SeoRequest, "id" | "organization_id" | "created_at">,
): Promise<T> {
  if (data.prompt_context_storage === "r2" || data.prompt_context === undefined) return data;

  const promptContext = await offloadTextField({
    namespace: ObjectNamespaces.SeoPayloads,
    organizationId: data.organization_id ?? context.organization_id,
    objectId: context.id,
    field: "prompt_context",
    createdAt: data.created_at ?? context.created_at ?? new Date(),
    value: data.prompt_context,
  });

  return {
    ...data,
    prompt_context: promptContext.value,
    prompt_context_storage: promptContext.storage,
    prompt_context_key: promptContext.key,
  };
}

async function prepareSeoRequestInsertData(data: NewSeoRequest): Promise<NewSeoRequest> {
  const id = data.id ?? randomUUID();
  const createdAt = data.created_at ?? new Date();
  return await prepareSeoRequestPayload(
    { ...data, id, created_at: createdAt },
    { id, organization_id: data.organization_id, created_at: createdAt },
  );
}

export class SeoRequestsRepository {
  async findById(id: string): Promise<SeoRequest | undefined> {
    const request = await db.query.seoRequests.findFirst({
      where: eq(seoRequests.id, id),
    });
    return request ? await hydrateSeoRequest(request) : undefined;
  }

  async findByIdempotency(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<SeoRequest | undefined> {
    const request = await db.query.seoRequests.findFirst({
      where: and(
        eq(seoRequests.organization_id, organizationId),
        eq(seoRequests.idempotency_key, idempotencyKey),
      ),
    });
    return request ? await hydrateSeoRequest(request) : undefined;
  }

  async listByOrganization(
    organizationId: string,
    options?: {
      limit?: number;
      status?: (typeof seoRequestStatusEnum.enumValues)[number];
    },
  ): Promise<SeoRequest[]> {
    const conditions = [eq(seoRequests.organization_id, organizationId)];
    if (options?.status) {
      conditions.push(eq(seoRequests.status, options.status));
    }

    return await db.query.seoRequests.findMany({
      where: conditions.length > 1 ? and(...conditions) : conditions[0],
      orderBy: desc(seoRequests.created_at),
      limit: options?.limit,
    });
  }

  async create(data: NewSeoRequest): Promise<SeoRequest> {
    const insertData = await prepareSeoRequestInsertData(data);
    const [request] = await db.insert(seoRequests).values(insertData).returning();
    return await hydrateSeoRequest(request);
  }

  async updateStatus(
    id: string,
    status: (typeof seoRequestStatusEnum.enumValues)[number],
    extras?: Partial<NewSeoRequest>,
  ): Promise<SeoRequest | undefined> {
    const existing =
      extras?.prompt_context !== undefined
        ? await db.query.seoRequests.findFirst({ where: eq(seoRequests.id, id) })
        : undefined;
    const preparedExtras = existing
      ? await prepareSeoRequestPayload(extras ?? {}, existing)
      : (extras ?? {});
    const [updated] = await db
      .update(seoRequests)
      .set({
        ...preparedExtras,
        status,
        updated_at: new Date(),
        ...(status === "completed" ? { completed_at: new Date() } : undefined),
      })
      .where(eq(seoRequests.id, id))
      .returning();
    return updated ? await hydrateSeoRequest(updated) : undefined;
  }
}

export const seoRequestsRepository = new SeoRequestsRepository();
