/**
 * IssueApiKeyUseCase — generate a key, persist the row, return both the
 * stored entity and the plaintext key (only surfaced once at issuance).
 */

import type { ApiKey, CreateApiKeyInput } from "@/lib/domain/api-key/api-key";
import type { ApiKeyRepository } from "@/lib/domain/api-key/api-key-repository";
import { generateApiKey } from "@/lib/domain/api-key/generate-api-key";

export interface IssueApiKeyResult {
  apiKey: ApiKey;
  plainKey: string;
}

export class IssueApiKeyUseCase {
  constructor(private readonly apiKeys: ApiKeyRepository) {}

  async execute(input: CreateApiKeyInput): Promise<IssueApiKeyResult> {
    const { key, hash, prefix } = generateApiKey();
    const apiKey = await this.apiKeys.create({
      ...input,
      key,
      key_hash: hash,
      key_prefix: prefix,
    });
    return { apiKey, plainKey: key };
  }
}
