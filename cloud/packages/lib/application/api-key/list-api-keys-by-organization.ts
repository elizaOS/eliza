import type { ApiKey } from "@/lib/domain/api-key/api-key";
import type { ApiKeyRepository } from "@/lib/domain/api-key/api-key-repository";

export class ListApiKeysByOrganizationUseCase {
  constructor(private readonly apiKeys: ApiKeyRepository) {}

  execute(organizationId: string): Promise<ApiKey[]> {
    return this.apiKeys.listByOrganization(organizationId);
  }
}
