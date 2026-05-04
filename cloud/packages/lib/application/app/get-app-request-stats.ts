import type { AppRepository } from "@/lib/domain/app/app-repository";

export class GetAppRequestStatsUseCase {
  constructor(private readonly apps: AppRepository) {}

  execute(appId: string, startDate?: Date, endDate?: Date): Promise<unknown> {
    return this.apps.getRequestStats(appId, startDate, endDate);
  }
}
