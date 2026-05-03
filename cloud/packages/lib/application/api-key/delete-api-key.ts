import type { ApiKeyRepository } from "@/lib/domain/api-key/api-key-repository";

export class DeleteApiKeyUseCase {
  constructor(private readonly apiKeys: ApiKeyRepository) {}

  execute(id: string): Promise<void> {
    return this.apiKeys.delete(id);
  }
}
