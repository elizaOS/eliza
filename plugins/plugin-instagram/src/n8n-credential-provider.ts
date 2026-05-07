import { type IAgentRuntime, Service } from '@elizaos/core';

// Inlined to avoid adding @elizaos/plugin-n8n-workflow as a compile-time dependency.
// The runtime duck-types the service — only the serviceType string and resolve() shape matter.
const N8N_CREDENTIAL_PROVIDER_TYPE = 'n8n_credential_provider';
type CredentialProviderResult =
  | { status: 'credential_data'; data: Record<string, unknown> }
  | { status: 'needs_auth'; authUrl: string }
  | null;

// The Instagram connector uses username/password (private API). There is no standard n8n node for this.
// Business accounts using Meta Graph API can be wired via facebookGraphApi credential.
// INSTAGRAM_PAGE_ACCESS_TOKEN must be a Meta Graph API page access token (not the login password).
const SUPPORTED = ['facebookGraphApi'];

export class InstagramN8nCredentialProvider extends Service {
  static override readonly serviceType = N8N_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription = 'Supplies Instagram (Meta Graph API) credentials to the n8n workflow plugin.';

  static async start(runtime: IAgentRuntime): Promise<InstagramN8nCredentialProvider> {
    return new InstagramN8nCredentialProvider(runtime);
  }

  async stop(): Promise<void> {}

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    if (credType !== 'facebookGraphApi') return null;
    const pageAccessToken = this.runtime.getSetting('INSTAGRAM_PAGE_ACCESS_TOKEN') as string | undefined;
    if (!pageAccessToken?.trim()) return null;
    return {
      status: 'credential_data',
      data: { accessToken: pageAccessToken.trim() },
    };
  }

  checkCredentialTypes(credTypes: string[]): { supported: string[]; unsupported: string[] } {
    return {
      supported: credTypes.filter((t) => SUPPORTED.includes(t)),
      unsupported: credTypes.filter((t) => !SUPPORTED.includes(t)),
    };
  }
}
