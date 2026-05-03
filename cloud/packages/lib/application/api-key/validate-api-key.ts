/**
 * ValidateApiKeyUseCase — hash a plaintext key and look up the active row.
 *
 * Returns the `ApiKey` row if the key is active and unexpired, `null` if
 * not. Caching, replica-vs-primary consistency, and negative caching are
 * handled inside the wired `ApiKeyRepository` (see
 * `CachedApiKeyRepository` + `PostgresApiKeyRepository`). The use case
 * stays pure orchestration.
 */

import type { ApiKey } from "@/lib/domain/api-key/api-key";
import type { ApiKeyRepository } from "@/lib/domain/api-key/api-key-repository";
import { hashApiKey } from "@/lib/domain/api-key/generate-api-key";

export class ValidateApiKeyUseCase {
  constructor(private readonly apiKeys: ApiKeyRepository) {}

  async execute(plainKey: string): Promise<ApiKey | null> {
    const hash = hashApiKey(plainKey);
    const found = await this.apiKeys.findActiveByHash(hash);
    return found ?? null;
  }
}
