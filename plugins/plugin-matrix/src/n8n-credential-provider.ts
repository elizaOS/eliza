import { type IAgentRuntime, Service } from '@elizaos/core';

// Inlined to avoid adding @elizaos/plugin-n8n-workflow as a compile-time dependency.
// The runtime duck-types the service — only the serviceType string and resolve() shape matter.
const N8N_CREDENTIAL_PROVIDER_TYPE = 'n8n_credential_provider';
type CredentialProviderResult =
  | { status: 'credential_data'; data: Record<string, unknown> }
  | { status: 'needs_auth'; authUrl: string }
  | null;

const SUPPORTED = ['matrixApi'];

export class MatrixN8nCredentialProvider extends Service {
  static override readonly serviceType = N8N_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription = 'Supplies Matrix credentials to the n8n workflow plugin.';

  static async start(runtime: IAgentRuntime): Promise<MatrixN8nCredentialProvider> {
    return new MatrixN8nCredentialProvider(runtime);
  }

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    if (credType !== 'matrixApi') return null;
    const accessToken = this.runtime.getSetting('MATRIX_ACCESS_TOKEN') as string | undefined;
    const homeserver = this.runtime.getSetting('MATRIX_HOMESERVER') as string | undefined;
    if (!accessToken?.trim() || !homeserver?.trim()) return null;
    return {
      status: 'credential_data',
      data: { accessToken: accessToken.trim(), homeserverUrl: homeserver.trim() },
    };
  }

  checkCredentialTypes(credTypes: string[]): { supported: string[]; unsupported: string[] } {
    return {
      supported: credTypes.filter((t) => SUPPORTED.includes(t)),
      unsupported: credTypes.filter((t) => !SUPPORTED.includes(t)),
    };
  }
}
