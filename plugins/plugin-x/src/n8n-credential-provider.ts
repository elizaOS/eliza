import { type IAgentRuntime, Service } from '@elizaos/core';

// Inlined to avoid adding @elizaos/plugin-n8n-workflow as a compile-time dependency.
// The runtime duck-types the service — only the serviceType string and resolve() shape matter.
const N8N_CREDENTIAL_PROVIDER_TYPE = 'n8n_credential_provider';
type CredentialProviderResult =
  | { status: 'credential_data'; data: Record<string, unknown> }
  | { status: 'needs_auth'; authUrl: string }
  | null;

const SUPPORTED = ['twitterOAuth2Api', 'twitterApi'];

export class XN8nCredentialProvider extends Service {
  static override readonly serviceType = N8N_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription = 'Supplies X (Twitter) credentials to the n8n workflow plugin.';

  static async start(runtime: IAgentRuntime): Promise<XN8nCredentialProvider> {
    return new XN8nCredentialProvider(runtime);
  }

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    const accessToken = this.runtime.getSetting('TWITTER_ACCESS_TOKEN') as string | undefined;
    const apiKey = this.runtime.getSetting('TWITTER_API_KEY') as string | undefined;
    const apiSecretKey = this.runtime.getSetting('TWITTER_API_SECRET_KEY') as string | undefined;
    const accessTokenSecret = this.runtime.getSetting('TWITTER_ACCESS_TOKEN_SECRET') as string | undefined;

    if (credType === 'twitterOAuth2Api') {
      if (!accessToken?.trim()) return null;
      return { status: 'credential_data', data: { accessToken: accessToken.trim() } };
    }
    if (credType === 'twitterApi') {
      if (!apiKey?.trim() || !apiSecretKey?.trim() || !accessToken?.trim() || !accessTokenSecret?.trim()) return null;
      return {
        status: 'credential_data',
        data: {
          consumerKey: apiKey.trim(),
          consumerSecret: apiSecretKey.trim(),
          accessToken: accessToken.trim(),
          accessTokenSecret: accessTokenSecret.trim(),
        },
      };
    }
    return null;
  }

  checkCredentialTypes(credTypes: string[]): { supported: string[]; unsupported: string[] } {
    return {
      supported: credTypes.filter((t) => SUPPORTED.includes(t)),
      unsupported: credTypes.filter((t) => !SUPPORTED.includes(t)),
    };
  }
}
