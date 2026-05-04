import type { AppRepository } from "@/lib/domain/app/app-repository";

export class GetAppTotalStatsUseCase {
  constructor(private readonly apps: AppRepository) {}

  execute(appId: string): Promise<unknown> {
    return this.apps.getTotalStats(appId);
  }
}
