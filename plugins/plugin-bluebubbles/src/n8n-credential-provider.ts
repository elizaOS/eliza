import { type IAgentRuntime, Service } from '@elizaos/core';

// Inlined to avoid adding @elizaos/plugin-n8n-workflow as a compile-time dependency.
// The runtime duck-types the service — only the serviceType string and resolve() shape matter.
const N8N_CREDENTIAL_PROVIDER_TYPE = 'n8n_credential_provider';
type CredentialProviderResult =
  | { status: 'credential_data'; data: Record<string, unknown> }
  | { status: 'needs_auth'; authUrl: string }
  | null;

// BlueBubbles REST API authenticates via a password query parameter.
// Note: BlueBubbles workflows are local-only — n8n must reach the BlueBubbles macOS server.
const SUPPORTED = ['httpQueryAuth'];

export class BlueBubblesN8nCredentialProvider extends Service {
  static override readonly serviceType = N8N_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription = 'Supplies BlueBubbles credentials to the n8n workflow plugin.';

  static async start(runtime: IAgentRuntime): Promise<BlueBubblesN8nCredentialProvider> {
    return new BlueBubblesN8nCredentialProvider(runtime);
  }

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    if (credType !== 'httpQueryAuth') return null;
    const password = this.runtime.getSetting('BLUEBUBBLES_PASSWORD') as string | undefined;
    const serverUrl = this.runtime.getSetting('BLUEBUBBLES_SERVER_URL') as string | undefined;
    if (!password?.trim() || !serverUrl?.trim()) return null;
    return {
      status: 'credential_data',
      data: { name: 'password', value: password.trim() },
    };
  }

  checkCredentialTypes(credTypes: string[]): { supported: string[]; unsupported: string[] } {
    return {
      supported: credTypes.filter((t) => SUPPORTED.includes(t)),
      unsupported: credTypes.filter((t) => !SUPPORTED.includes(t)),
    };
  }
}
