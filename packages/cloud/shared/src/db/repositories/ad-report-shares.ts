import { and, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type AdReportShare,
  adReportShares,
  type NewAdReportShare,
} from "../schemas/ad-report-shares";

export type { AdReportShare, NewAdReportShare };

export class AdReportSharesRepository {
  async create(data: NewAdReportShare): Promise<AdReportShare> {
    const [share] = await dbWrite.insert(adReportShares).values(data).returning();
    return share;
  }

  async findById(id: string): Promise<AdReportShare | undefined> {
    return dbRead.query.adReportShares.findFirst({
      where: eq(adReportShares.id, id),
    });
  }

  async findByTokenHash(tokenHash: string): Promise<AdReportShare | undefined> {
    return dbRead.query.adReportShares.findFirst({
      where: eq(adReportShares.token_hash, tokenHash),
    });
  }

  async revoke(id: string, organizationId: string): Promise<AdReportShare | undefined> {
    const [share] = await dbWrite
      .update(adReportShares)
      .set({
        status: "revoked",
        revoked_at: new Date(),
        updated_at: new Date(),
      })
      .where(and(eq(adReportShares.id, id), eq(adReportShares.organization_id, organizationId)))
      .returning();
    return share;
  }
}

export const adReportSharesRepository = new AdReportSharesRepository();
