import { type IAgentRuntime, Service } from '@elizaos/core';

// Inlined to avoid adding @elizaos/plugin-n8n-workflow as a compile-time dependency.
// The runtime duck-types the service — only the serviceType string and resolve() shape matter.
const N8N_CREDENTIAL_PROVIDER_TYPE = 'n8n_credential_provider';
type CredentialProviderResult =
  | { status: 'credential_data'; data: Record<string, unknown> }
  | { status: 'needs_auth'; authUrl: string }
  | null;

// LINE has no dedicated n8n node. Use HTTP Request node with httpHeaderAuth.
const SUPPORTED = ['httpHeaderAuth'];

export class LineN8nCredentialProvider extends Service {
  static override readonly serviceType = N8N_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription = 'Supplies LINE credentials to the n8n workflow plugin.';

  static async start(runtime: IAgentRuntime): Promise<LineN8nCredentialProvider> {
    return new LineN8nCredentialProvider(runtime);
  }

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    if (credType !== 'httpHeaderAuth') return null;
    const accessToken = this.runtime.getSetting('LINE_CHANNEL_ACCESS_TOKEN') as string | undefined;
    if (!accessToken?.trim()) return null;
    return {
      status: 'credential_data',
      data: { name: 'Authorization', value: `Bearer ${accessToken.trim()}` },
    };
  }

  checkCredentialTypes(credTypes: string[]): { supported: string[]; unsupported: string[] } {
    return {
      supported: credTypes.filter((t) => SUPPORTED.includes(t)),
      unsupported: credTypes.filter((t) => !SUPPORTED.includes(t)),
    };
  }
}
