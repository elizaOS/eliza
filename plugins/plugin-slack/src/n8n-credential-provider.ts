import { type IAgentRuntime, Service } from '@elizaos/core';

// Inlined to avoid adding @elizaos/plugin-n8n-workflow as a compile-time dependency.
// The runtime duck-types the service — only the serviceType string and resolve() shape matter.
const N8N_CREDENTIAL_PROVIDER_TYPE = 'n8n_credential_provider';
type CredentialProviderResult =
  | { status: 'credential_data'; data: Record<string, unknown> }
  | { status: 'needs_auth'; authUrl: string }
  | null;

const SUPPORTED = ['slackApi', 'slackOAuth2Api'];

export class SlackN8nCredentialProvider extends Service {
  static override readonly serviceType = N8N_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription = 'Supplies Slack credentials to the n8n workflow plugin.';

  static async start(runtime: IAgentRuntime): Promise<SlackN8nCredentialProvider> {
    return new SlackN8nCredentialProvider(runtime);
  }

  async stop(): Promise<void> {}

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    const botToken = this.runtime.getSetting('SLACK_BOT_TOKEN') as string | undefined;
    const appToken = this.runtime.getSetting('SLACK_APP_TOKEN') as string | undefined;
    if (credType === 'slackApi' && botToken?.trim()) {
      return { status: 'credential_data', data: { accessToken: botToken.trim() } };
    }
    if (credType === 'slackOAuth2Api' && appToken?.trim()) {
      return { status: 'credential_data', data: { accessToken: appToken.trim() } };
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
