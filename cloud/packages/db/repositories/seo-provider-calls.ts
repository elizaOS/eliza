import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { ObjectNamespaces } from "@/lib/storage/object-namespace";
import { hydrateJsonField, offloadJsonField } from "@/lib/storage/object-store";
import { db } from "../client";
import {
  type NewSeoProviderCall,
  type SeoProviderCall,
  seoProviderCalls,
  seoRequests,
} from "../schemas/seo";

export type { NewSeoProviderCall, SeoProviderCall };

async function requestOrganizationId(requestId: string): Promise<string> {
  const request = await db.query.seoRequests.findFirst({
    where: eq(seoRequests.id, requestId),
    columns: { organization_id: true },
  });
  if (!request) throw new Error(`SEO request not found: ${requestId}`);
  return request.organization_id;
}

async function hydrateSeoProviderCall(call: SeoProviderCall): Promise<SeoProviderCall> {
  const [requestPayload, responsePayload] = await Promise.all([
    hydrateJsonField<Record<string, unknown>>({
      storage: call.request_payload_storage,
      key: call.request_payload_key,
      inlineValue: call.request_payload ?? null,
    }),
    hydrateJsonField<Record<string, unknown>>({
      storage: call.response_payload_storage,
      key: call.response_payload_key,
      inlineValue: call.response_payload ?? null,
    }),
  ]);

  return {
    ...call,
    request_payload: requestPayload,
    response_payload: responsePayload,
  };
}

async function prepareSeoProviderCallPayload<
  T extends NewSeoProviderCall | Partial<NewSeoProviderCall>,
>(data: T, context: Pick<SeoProviderCall, "id" | "request_id" | "created_at">): Promise<T> {
  if (data.request_payload_storage === "r2" || data.response_payload_storage === "r2") {
    return data;
  }

  const createdAt = data.created_at ?? context.created_at ?? new Date();
  const organizationId = await requestOrganizationId(data.request_id ?? context.request_id);
  const [requestPayload, responsePayload] = await Promise.all([
    data.request_payload === undefined
      ? Promise.resolve(null)
      : offloadJsonField<Record<string, unknown>>({
          namespace: ObjectNamespaces.SeoPayloads,
          organizationId,
          objectId: context.id,
          field: "request_payload",
          createdAt,
          value: data.request_payload,
          inlineValueWhenOffloaded: null,
        }),
    data.response_payload === undefined
      ? Promise.resolve(null)
      : offloadJsonField<Record<string, unknown>>({
          namespace: ObjectNamespaces.SeoPayloads,
          organizationId,
          objectId: context.id,
          field: "response_payload",
          createdAt,
          value: data.response_payload,
          inlineValueWhenOffloaded: null,
        }),
  ]);

  return {
    ...data,
    ...(requestPayload
      ? {
          request_payload: requestPayload.value,
          request_payload_storage: requestPayload.storage,
          request_payload_key: requestPayload.key,
        }
      : {}),
    ...(responsePayload
      ? {
          response_payload: responsePayload.value,
          response_payload_storage: responsePayload.storage,
          response_payload_key: responsePayload.key,
        }
      : {}),
  };
}

async function prepareSeoProviderCallInsertData(
  data: NewSeoProviderCall,
): Promise<NewSeoProviderCall> {
  const id = data.id ?? randomUUID();
  const createdAt = data.created_at ?? new Date();
  return await prepareSeoProviderCallPayload(
    { ...data, id, created_at: createdAt },
    { id, request_id: data.request_id, created_at: createdAt },
  );
}

export class SeoProviderCallsRepository {
  async listByRequest(requestId: string): Promise<SeoProviderCall[]> {
    const rows = await db.query.seoProviderCalls.findMany({
      where: eq(seoProviderCalls.request_id, requestId),
      orderBy: desc(seoProviderCalls.created_at),
    });
    return await Promise.all(rows.map(hydrateSeoProviderCall));
  }

  async create(data: NewSeoProviderCall): Promise<SeoProviderCall> {
    const insertData = await prepareSeoProviderCallInsertData(data);
    const [call] = await db.insert(seoProviderCalls).values(insertData).returning();
    return await hydrateSeoProviderCall(call);
  }

  async updateStatus(
    id: string,
    status: SeoProviderCall["status"],
    extras?: Partial<NewSeoProviderCall>,
  ): Promise<SeoProviderCall | undefined> {
    const existing =
      extras && (extras.request_payload !== undefined || extras.response_payload !== undefined)
        ? await db.query.seoProviderCalls.findFirst({ where: eq(seoProviderCalls.id, id) })
        : undefined;
    const preparedExtras = existing
      ? await prepareSeoProviderCallPayload(extras ?? {}, existing)
      : (extras ?? {});
    const [updated] = await db
      .update(seoProviderCalls)
      .set({
        ...preparedExtras,
        status,
        completed_at: new Date(),
      })
      .where(eq(seoProviderCalls.id, id))
      .returning();
    return updated ? await hydrateSeoProviderCall(updated) : undefined;
  }
}

export const seoProviderCallsRepository = new SeoProviderCallsRepository();
