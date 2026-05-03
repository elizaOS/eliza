/**
 * DeactivateApiKeysByNameUseCase — used by SIWE sign-in to invalidate any
 * previous "SIWE sign-in" key for the same user before issuing a fresh one.
 */

import type { ApiKeyRepository } from "@/lib/domain/api-key/api-key-repository";

export class DeactivateApiKeysByNameUseCase {
  constructor(private readonly apiKeys: ApiKeyRepository) {}

  execute(userId: string, name: string): Promise<void> {
    return this.apiKeys.deactivateUserKeysByName(userId, name);
  }
}
