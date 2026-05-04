import type { AppRepository } from "@/lib/domain/app/app-repository";

export class GetAppRecentRequestsUseCase {
  constructor(private readonly apps: AppRepository) {}

  execute(
    appId: string,
    options?: {
      limit?: number;
      offset?: number;
      requestType?: string;
      source?: string;
      startDate?: Date;
      endDate?: Date;
    },
  ): Promise<unknown> {
    return this.apps.getRecentRequests(appId, options);
  }
}
