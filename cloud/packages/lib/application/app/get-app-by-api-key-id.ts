import type { App } from "@/lib/domain/app/app";
import type { AppRepository } from "@/lib/domain/app/app-repository";

export class GetAppByApiKeyIdUseCase {
  constructor(private readonly apps: AppRepository) {}

  execute(apiKeyId: string): Promise<App | undefined> {
    return this.apps.findByApiKeyId(apiKeyId);
  }
}
