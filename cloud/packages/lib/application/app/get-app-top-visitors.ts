import type { AppRepository } from "@/lib/domain/app/app-repository";

export class GetAppTopVisitorsUseCase {
  constructor(private readonly apps: AppRepository) {}

  execute(
    appId: string,
    limit?: number,
    startDate?: Date,
    endDate?: Date,
  ): Promise<unknown> {
    return this.apps.getTopVisitors(appId, limit, startDate, endDate);
  }
}
