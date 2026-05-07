import { type IAgentRuntime, Service } from '@elizaos/core';
import { N8N_CREDENTIAL_PROVIDER_TYPE } from '@elizaos/plugin-n8n-workflow/types/index';
import type { CredentialProvider, CredentialProviderResult, CheckCredentialTypesResult } from '@elizaos/plugin-n8n-workflow/types/index';

const SUPPORTED = ['slackApi', 'slackOAuth2Api'];

export class SlackN8nCredentialProvider extends Service implements CredentialProvider {
  static override readonly serviceType = N8N_CREDENTIAL_PROVIDER_TYPE;

  override capabilityDescription = 'Supplies Slack credentials to the n8n workflow plugin.';

  static async start(runtime: IAgentRuntime): Promise<SlackN8nCredentialProvider> {
    return new SlackN8nCredentialProvider(runtime);
  }

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

  checkCredentialTypes(credTypes: string[]): CheckCredentialTypesResult {
    return {
      supported: credTypes.filter((t) => SUPPORTED.includes(t)),
      unsupported: credTypes.filter((t) => !SUPPORTED.includes(t)),
    };
  }
}
