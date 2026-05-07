import { type IAgentRuntime, Service } from '@elizaos/core';

// Inlined to avoid adding @elizaos/plugin-n8n-workflow as a compile-time dependency.
// The runtime duck-types the service — only the serviceType string and resolve() shape matter.
const N8N_CREDENTIAL_PROVIDER_TYPE = 'n8n_credential_provider';
type CredentialProviderResult =
  | { status: 'credential_data'; data: Record<string, unknown> }
  | { status: 'needs_auth'; authUrl: string }
  | null;

// Bluesky (AT Protocol) uses app password credentials. No dedicated n8n node; use HTTP Request node.
// The runtime supplies handle + app password; workflows call com.atproto.server.createSession to get JWT.
const SUPPORTED = ['httpHeaderAuth'];

export class BlueskyN8nCredentialProvider extends Service {
  static override readonly serviceType = N8N_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription = 'Supplies Bluesky credentials to the n8n workflow plugin.';

  static async start(runtime: IAgentRuntime): Promise<BlueskyN8nCredentialProvider> {
    return new BlueskyN8nCredentialProvider(runtime);
  }

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    if (credType !== 'httpHeaderAuth') return null;
    const handle = this.runtime.getSetting('BLUESKY_HANDLE') as string | undefined;
    const password = this.runtime.getSetting('BLUESKY_PASSWORD') as string | undefined;
    if (!handle?.trim() || !password?.trim()) return null;
    // Surface handle as header sentinel; the n8n workflow must call createSession to obtain the JWT.
    return {
      status: 'credential_data',
      data: { name: 'X-Bluesky-Handle', value: handle.trim() },
    };
  }

  checkCredentialTypes(credTypes: string[]): { supported: string[]; unsupported: string[] } {
    return {
      supported: credTypes.filter((t) => SUPPORTED.includes(t)),
      unsupported: credTypes.filter((t) => !SUPPORTED.includes(t)),
    };
  }
}
