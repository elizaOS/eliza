import type { AppRepository } from "@/lib/domain/app/app-repository";

export class GetAppUsersUseCase {
  constructor(private readonly apps: AppRepository) {}

  execute(appId: string, limit?: number): Promise<unknown> {
    return this.apps.getAppUsers(appId, limit);
  }
}
