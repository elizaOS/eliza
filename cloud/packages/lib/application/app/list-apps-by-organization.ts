import type { App } from "@/lib/domain/app/app";
import type { AppRepository } from "@/lib/domain/app/app-repository";

export class ListAppsByOrganizationUseCase {
  constructor(private readonly apps: AppRepository) {}

  execute(organizationId: string): Promise<App[]> {
    return this.apps.listByOrganization(organizationId);
  }
}
