import { type IAgentRuntime, Service } from '@elizaos/core';

const WORKFLOW_CREDENTIAL_PROVIDER_TYPE = 'workflow_credential_provider';
type CredentialProviderResult =
  | { status: 'credential_data'; data: Record<string, unknown> }
  | { status: 'needs_auth'; authUrl: string }
  | null;

const SUPPORTED = ['whatsAppApi'];

export class WhatsAppWorkflowCredentialProvider extends Service {
  static override readonly serviceType = WORKFLOW_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription = 'Supplies WhatsApp credentials to the workflow plugin.';

  static async start(runtime: IAgentRuntime): Promise<WhatsAppWorkflowCredentialProvider> {
    return new WhatsAppWorkflowCredentialProvider(runtime);
  }

  async stop(): Promise<void> {}

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    if (credType !== 'whatsAppApi') return null;
    const accessToken = this.runtime.getSetting('WHATSAPP_ACCESS_TOKEN') as string | undefined;
    const phoneNumberId = this.runtime.getSetting('WHATSAPP_PHONE_NUMBER_ID') as string | undefined;
    if (!accessToken?.trim() || !phoneNumberId?.trim()) return null;
    return {
      status: 'credential_data',
      data: { accessToken: accessToken.trim(), phoneNumberId: phoneNumberId.trim() },
    };
  }

  checkCredentialTypes(credTypes: string[]): { supported: string[]; unsupported: string[] } {
    return {
      supported: credTypes.filter((t) => SUPPORTED.includes(t)),
      unsupported: credTypes.filter((t) => !SUPPORTED.includes(t)),
    };
  }
}
