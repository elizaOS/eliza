import { type IAgentRuntime, Service } from '@elizaos/core';

// Inlined to avoid adding @elizaos/plugin-n8n-workflow as a compile-time dependency.
// The runtime duck-types the service — only the serviceType string and resolve() shape matter.
const N8N_CREDENTIAL_PROVIDER_TYPE = 'n8n_credential_provider';
type CredentialProviderResult =
  | { status: 'credential_data'; data: Record<string, unknown> }
  | { status: 'needs_auth'; authUrl: string }
  | null;

const SUPPORTED = ['googleChatOAuth2Api'];

export class GoogleChatN8nCredentialProvider extends Service {
  static override readonly serviceType = N8N_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription = 'Supplies Google Chat credentials to the n8n workflow plugin.';

  static async start(runtime: IAgentRuntime): Promise<GoogleChatN8nCredentialProvider> {
    return new GoogleChatN8nCredentialProvider(runtime);
  }

  async stop(): Promise<void> {}

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    if (credType !== 'googleChatOAuth2Api') return null;
    // Google Chat service account credentials — prefer JSON inline, fallback to file path.
    const serviceAccountJson = this.runtime.getSetting('GOOGLE_CHAT_SERVICE_ACCOUNT') as string | undefined;
    const serviceAccountFile = this.runtime.getSetting('GOOGLE_CHAT_SERVICE_ACCOUNT_FILE') as string | undefined;
    const appCredentials = this.runtime.getSetting('GOOGLE_APPLICATION_CREDENTIALS') as string | undefined;
    const credentialsSource = serviceAccountJson?.trim() || serviceAccountFile?.trim() || appCredentials?.trim();
    if (!credentialsSource) return null;
    return {
      status: 'credential_data',
      data: { serviceAccountKey: credentialsSource },
    };
  }

  checkCredentialTypes(credTypes: string[]): { supported: string[]; unsupported: string[] } {
    return {
      supported: credTypes.filter((t) => SUPPORTED.includes(t)),
      unsupported: credTypes.filter((t) => !SUPPORTED.includes(t)),
    };
  }
}
