import type { App } from "@/lib/domain/app/app";
import type { AppRepository } from "@/lib/domain/app/app-repository";

export class GetAppByIdUseCase {
  constructor(private readonly apps: AppRepository) {}

  execute(id: string): Promise<App | undefined> {
    return this.apps.findById(id);
  }
}
