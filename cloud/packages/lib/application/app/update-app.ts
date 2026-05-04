import type { App, NewApp } from "@/lib/domain/app/app";
import type { AppRepository } from "@/lib/domain/app/app-repository";

export class UpdateAppUseCase {
  constructor(private readonly apps: AppRepository) {}

  execute(id: string, data: Partial<NewApp>): Promise<App | undefined> {
    return this.apps.update(id, data);
  }
}
