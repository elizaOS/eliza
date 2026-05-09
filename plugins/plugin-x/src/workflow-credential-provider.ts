import { type IAgentRuntime, Service } from '@elizaos/core';

// Inlined to avoid adding @elizaos/plugin-workflow as a compile-time dependency.
// The runtime duck-types the service — only the serviceType string and resolve() shape matter.
const WORKFLOW_CREDENTIAL_PROVIDER_TYPE = 'workflow_credential_provider';
type CredentialProviderResult =
  | { status: 'credential_data'; data: Record<string, unknown> }
  | { status: 'needs_auth'; authUrl: string }
  | null;

// plugin-x exposes OAuth 1.0a User Context credentials (TWITTER_API_KEY, TWITTER_API_SECRET_KEY,
// TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET). The workflow runtime's twitterApi credential
// type uses these directly. twitterOAuth2Api expects an OAuth 2.0 access token from the
// Authorization Code Grant flow — we have no env var that provides one (TWITTER_CLIENT_ID alone
// is insufficient), so wiring TWITTER_ACCESS_TOKEN as an OAuth2 access token would silently fail
// at execution time.
const SUPPORTED = ['twitterApi'];

export class XWorkflowCredentialProvider extends Service {
  static override readonly serviceType = WORKFLOW_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription =
    'Supplies X (Twitter) credentials to the workflow plugin.';

  static async start(runtime: IAgentRuntime): Promise<XWorkflowCredentialProvider> {
    return new XWorkflowCredentialProvider(runtime);
  }

  async stop(): Promise<void> {}

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    if (credType !== 'twitterApi') return null;
    const apiKey = this.runtime.getSetting('TWITTER_API_KEY') as string | undefined;
    const apiSecretKey = this.runtime.getSetting('TWITTER_API_SECRET_KEY') as string | undefined;
    const accessToken = this.runtime.getSetting('TWITTER_ACCESS_TOKEN') as string | undefined;
    const accessTokenSecret = this.runtime.getSetting('TWITTER_ACCESS_TOKEN_SECRET') as
      | string
      | undefined;
    if (
      !apiKey?.trim() ||
      !apiSecretKey?.trim() ||
      !accessToken?.trim() ||
      !accessTokenSecret?.trim()
    ) {
      return null;
    }
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

  checkCredentialTypes(credTypes: string[]): { supported: string[]; unsupported: string[] } {
    return {
      supported: credTypes.filter((t) => SUPPORTED.includes(t)),
      unsupported: credTypes.filter((t) => !SUPPORTED.includes(t)),
    };
  }
}
