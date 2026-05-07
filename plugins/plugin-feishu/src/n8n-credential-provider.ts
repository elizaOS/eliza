import { type IAgentRuntime, Service } from '@elizaos/core';

// Inlined to avoid adding @elizaos/plugin-n8n-workflow as a compile-time dependency.
// The runtime duck-types the service — only the serviceType string and resolve() shape matter.
const N8N_CREDENTIAL_PROVIDER_TYPE = 'n8n_credential_provider';
type CredentialProviderResult =
  | { status: 'credential_data'; data: Record<string, unknown> }
  | { status: 'needs_auth'; authUrl: string }
  | null;

// Feishu has no dedicated n8n node. Use HTTP Request node with httpHeaderAuth.
// The Feishu service manages token refresh internally; we surface the app credentials.
const SUPPORTED = ['httpHeaderAuth'];

export class FeishuN8nCredentialProvider extends Service {
  static override readonly serviceType = N8N_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription = 'Supplies Feishu/Lark credentials to the n8n workflow plugin.';

  static async start(runtime: IAgentRuntime): Promise<FeishuN8nCredentialProvider> {
    return new FeishuN8nCredentialProvider(runtime);
  }

  async stop(): Promise<void> {}

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    if (credType !== 'httpHeaderAuth') return null;
    const appId = this.runtime.getSetting('FEISHU_APP_ID') as string | undefined;
    const appSecret = this.runtime.getSetting('FEISHU_APP_SECRET') as string | undefined;
    if (!appId?.trim() || !appSecret?.trim()) return null;
    // Surface app credentials; workflows call the Feishu auth API to get a tenant_access_token.
    return {
      status: 'credential_data',
      data: { name: 'X-Feishu-App-Id', value: appId.trim() },
    };
  }

  checkCredentialTypes(credTypes: string[]): { supported: string[]; unsupported: string[] } {
    return {
      supported: credTypes.filter((t) => SUPPORTED.includes(t)),
      unsupported: credTypes.filter((t) => !SUPPORTED.includes(t)),
    };
  }
}
