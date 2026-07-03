import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import { type CloudFile, cloudFiles, type NewCloudFile } from "../schemas/cloud-files";

export type { CloudFile, NewCloudFile };

export interface CloudFileListOptions {
  limit?: number;
  offset?: number;
  source?: string;
  kind?: string;
  mimeType?: string;
  search?: string;
}

function boundedLimit(limit?: number): number {
  return Math.min(Math.max(limit ?? 50, 1), 200);
}

export class CloudFilesRepository {
  async create(data: NewCloudFile): Promise<CloudFile> {
    const [row] = await dbWrite.insert(cloudFiles).values(data).returning();
    return row;
  }

  async findActiveByOrgAndId(organizationId: string, id: string): Promise<CloudFile | undefined> {
    return await dbRead.query.cloudFiles.findFirst({
      where: and(
        eq(cloudFiles.organization_id, organizationId),
        eq(cloudFiles.id, id),
        eq(cloudFiles.status, "active"),
      ),
    });
  }

  async listByOrganization(
    organizationId: string,
    options: CloudFileListOptions = {},
  ): Promise<{ items: CloudFile[]; hasMore: boolean; limit: number; offset: number }> {
    const limit = boundedLimit(options.limit);
    const offset = Math.max(options.offset ?? 0, 0);
    const conditions = [
      eq(cloudFiles.organization_id, organizationId),
      eq(cloudFiles.status, "active"),
    ];

    if (options.source) conditions.push(eq(cloudFiles.source, options.source));
    if (options.kind) conditions.push(eq(cloudFiles.kind, options.kind));
    if (options.mimeType) conditions.push(eq(cloudFiles.mime_type, options.mimeType));
    if (options.search) {
      conditions.push(ilike(cloudFiles.filename, `%${options.search}%`));
    }

    const rows = await dbRead.query.cloudFiles.findMany({
      where: and(...conditions),
      orderBy: desc(cloudFiles.created_at),
      limit: limit + 1,
      offset,
    });

    return {
      items: rows.slice(0, limit),
      hasMore: rows.length > limit,
      limit,
      offset,
    };
  }

  async softDeleteByOrgAndId(organizationId: string, id: string): Promise<CloudFile | undefined> {
    const [row] = await dbWrite
      .update(cloudFiles)
      .set({
        status: "deleted",
        deleted_at: new Date(),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(cloudFiles.organization_id, organizationId),
          eq(cloudFiles.id, id),
          eq(cloudFiles.status, "active"),
        ),
      )
      .returning();
    return row;
  }

  async activeStorageKeyReferences(organizationId: string, storageKey: string): Promise<number> {
    const [row] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(cloudFiles)
      .where(
        and(
          eq(cloudFiles.organization_id, organizationId),
          eq(cloudFiles.storage_key, storageKey),
          eq(cloudFiles.status, "active"),
        ),
      );
    return row?.count ?? 0;
  }
}

export const cloudFilesRepository = new CloudFilesRepository();
