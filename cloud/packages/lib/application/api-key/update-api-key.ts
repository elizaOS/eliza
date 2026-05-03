import type { ApiKey, NewApiKey } from "@/lib/domain/api-key/api-key";
import type { ApiKeyRepository } from "@/lib/domain/api-key/api-key-repository";

export class UpdateApiKeyUseCase {
  constructor(private readonly apiKeys: ApiKeyRepository) {}

  execute(id: string, data: Partial<NewApiKey>): Promise<ApiKey | undefined> {
    return this.apiKeys.update(id, data);
  }
}
