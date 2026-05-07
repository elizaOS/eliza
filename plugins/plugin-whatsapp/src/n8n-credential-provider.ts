import { type IAgentRuntime, Service } from '@elizaos/core';
import { N8N_CREDENTIAL_PROVIDER_TYPE } from '@elizaos/plugin-n8n-workflow/types/index';
import type { CredentialProvider, CredentialProviderResult, CheckCredentialTypesResult } from '@elizaos/plugin-n8n-workflow/types/index';

const SUPPORTED = ['whatsAppApi'];

export class WhatsAppN8nCredentialProvider extends Service implements CredentialProvider {
  static override readonly serviceType = N8N_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription = 'Supplies WhatsApp credentials to the n8n workflow plugin.';

  static async start(runtime: IAgentRuntime): Promise<WhatsAppN8nCredentialProvider> {
    return new WhatsAppN8nCredentialProvider(runtime);
  }

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    if (credType !== 'whatsAppApi') return null;
    const accessToken = this.runtime.getSetting('WHATSAPP_ACCESS_TOKEN') as string | undefined;
    const phoneNumberId = this.runtime.getSetting('WHATSAPP_PHONE_NUMBER_ID') as string | undefined;
    if (!accessToken?.trim() || !phoneNumberId?.trim()) return null;
    return { status: 'credential_data', data: { accessToken: accessToken.trim(), phoneNumberId: phoneNumberId.trim() } };
  }

  checkCredentialTypes(credTypes: string[]): CheckCredentialTypesResult {
    return {
      supported: credTypes.filter((t) => SUPPORTED.includes(t)),
      unsupported: credTypes.filter((t) => !SUPPORTED.includes(t)),
    };
  }
}
