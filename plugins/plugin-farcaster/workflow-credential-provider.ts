/**
 * Supplies the Neynar API key to the workflow plugin as `httpHeaderAuth`
 * credentials, so Farcaster HTTP Request nodes authenticate without the agent
 * re-entering keys. Registered in the plugin's services; the workflow plugin
 * duck-types it by `serviceType`, so there is no compile-time dependency on it.
 */
import { type IAgentRuntime, Service } from '@elizaos/core';

// Inlined to avoid adding @elizaos/plugin-workflow as a compile-time dependency.
// The runtime duck-types the service — only the serviceType string and resolve() shape matter.
const WORKFLOW_CREDENTIAL_PROVIDER_TYPE = 'workflow_credential_provider';
type CredentialProviderResult =
  | { status: 'credential_data'; data: Record<string, unknown> }
  | { status: 'needs_auth'; authUrl: string }
  | null;

// Farcaster uses the Neynar API (api-key header). No dedicated workflow node; use HTTP Request node.
const SUPPORTED = ['httpHeaderAuth'];

export class FarcasterWorkflowCredentialProvider extends Service {
  static override readonly serviceType = WORKFLOW_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription =
    'Supplies Farcaster (Neynar API) credentials to the workflow plugin.';

  static async start(runtime: IAgentRuntime): Promise<FarcasterWorkflowCredentialProvider> {
    return new FarcasterWorkflowCredentialProvider(runtime);
  }

  async stop(): Promise<void> {}

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    if (credType !== 'httpHeaderAuth') return null;
    let neynarApiKey: string | undefined;
    try {
      neynarApiKey = this.runtime.getSetting('FARCASTER_NEYNAR_API_KEY') as string | undefined;
    } catch {
      return null;
    }
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
