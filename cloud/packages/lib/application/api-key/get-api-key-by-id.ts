import type { ApiKey } from "@/lib/domain/api-key/api-key";
import type { ApiKeyRepository } from "@/lib/domain/api-key/api-key-repository";

export class GetApiKeyByIdUseCase {
  constructor(private readonly apiKeys: ApiKeyRepository) {}

  execute(id: string): Promise<ApiKey | undefined> {
    return this.apiKeys.findById(id);
  }
}
