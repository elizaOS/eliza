import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { ObjectNamespaces } from "@/lib/storage/object-namespace";
import { hydrateJsonField, offloadJsonField } from "@/lib/storage/object-store";
import { db } from "../client";
import {
  type NewSeoArtifact,
  type SeoArtifact,
  seoArtifacts,
  seoArtifactTypeEnum,
  seoRequests,
} from "../schemas/seo";

export type { NewSeoArtifact, SeoArtifact };

async function requestOrganizationId(requestId: string): Promise<string> {
  const request = await db.query.seoRequests.findFirst({
    where: eq(seoRequests.id, requestId),
    columns: { organization_id: true },
  });
  if (!request) throw new Error(`SEO request not found: ${requestId}`);
  return request.organization_id;
}

async function hydrateSeoArtifact(artifact: SeoArtifact): Promise<SeoArtifact> {
  const data = await hydrateJsonField<Record<string, unknown>>({
    storage: artifact.data_storage,
    key: artifact.data_key,
    inlineValue: artifact.data,
  });

  return { ...artifact, data: data ?? {} };
}

async function prepareSeoArtifactInsertData(data: NewSeoArtifact): Promise<NewSeoArtifact> {
  if (data.data_storage === "r2") return data;

  const id = data.id ?? randomUUID();
  const createdAt = data.created_at ?? new Date();
  const payload = await offloadJsonField<Record<string, unknown>>({
    namespace: ObjectNamespaces.SeoPayloads,
    organizationId: await requestOrganizationId(data.request_id),
    objectId: id,
    field: "artifact_data",
    createdAt,
    value: data.data,
    inlineValueWhenOffloaded: {},
  });

  return {
    ...data,
    id,
    created_at: createdAt,
    data: payload.value ?? {},
    data_storage: payload.storage,
    data_key: payload.key,
  };
}

export class SeoArtifactsRepository {
  async listByRequest(
    requestId: string,
    options?: { type?: (typeof seoArtifactTypeEnum.enumValues)[number] },
  ): Promise<SeoArtifact[]> {
    const rows = await db.query.seoArtifacts.findMany({
      where: options?.type
        ? and(eq(seoArtifacts.request_id, requestId), eq(seoArtifacts.type, options.type))
        : eq(seoArtifacts.request_id, requestId),
      orderBy: desc(seoArtifacts.created_at),
    });
    return await Promise.all(rows.map(hydrateSeoArtifact));
  }

  async create(data: NewSeoArtifact): Promise<SeoArtifact> {
    const insertData = await prepareSeoArtifactInsertData(data);
    const [artifact] = await db.insert(seoArtifacts).values(insertData).returning();
    return await hydrateSeoArtifact(artifact);
  }
}

export const seoArtifactsRepository = new SeoArtifactsRepository();
