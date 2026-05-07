import { type IAgentRuntime, Service } from '@elizaos/core';

// Inlined to avoid adding @elizaos/plugin-n8n-workflow as a compile-time dependency.
// The runtime duck-types the service — only the serviceType string and resolve() shape matter.
const N8N_CREDENTIAL_PROVIDER_TYPE = 'n8n_credential_provider';
type CredentialProviderResult =
  | { status: 'credential_data'; data: Record<string, unknown> }
  | { status: 'needs_auth'; authUrl: string }
  | null;

// Farcaster uses the Neynar API (api-key header). No dedicated n8n node; use HTTP Request node.
const SUPPORTED = ['httpHeaderAuth'];

export class FarcasterN8nCredentialProvider extends Service {
  static override readonly serviceType = N8N_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription = 'Supplies Farcaster (Neynar API) credentials to the n8n workflow plugin.';

  static async start(runtime: IAgentRuntime): Promise<FarcasterN8nCredentialProvider> {
    return new FarcasterN8nCredentialProvider(runtime);
  }

  async stop(): Promise<void> {}

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    if (credType !== 'httpHeaderAuth') return null;
    const neynarApiKey = this.runtime.getSetting('FARCASTER_NEYNAR_API_KEY') as string | undefined;
    if (!neynarApiKey?.trim()) return null;
    return {
      status: 'credential_data',
      data: { name: 'api_key', value: neynarApiKey.trim() },
    };
  }

  checkCredentialTypes(credTypes: string[]): { supported: string[]; unsupported: string[] } {
    return {
      supported: credTypes.filter((t) => SUPPORTED.includes(t)),
      unsupported: credTypes.filter((t) => !SUPPORTED.includes(t)),
    };
  }
}
