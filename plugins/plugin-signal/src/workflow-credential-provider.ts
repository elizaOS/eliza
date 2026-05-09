import { type IAgentRuntime, Service } from '@elizaos/core';

// Inlined to avoid adding @elizaos/plugin-workflow as a compile-time dependency.
// The runtime duck-types the service — only the serviceType string and resolve() shape matter.
const WORKFLOW_CREDENTIAL_PROVIDER_TYPE = 'workflow_credential_provider';
type CredentialProviderResult =
  | { status: 'credential_data'; data: Record<string, unknown> }
  | { status: 'needs_auth'; authUrl: string }
  | null;

// Signal uses signal-cli REST API (local only). Wire via httpHeaderAuth pointing at the local endpoint.
// Note: Signal workflows are local-only — the workflow runtime must be on the same host as signal-cli.
const SUPPORTED = ['httpHeaderAuth'];

export class SignalWorkflowCredentialProvider extends Service {
  static override readonly serviceType = WORKFLOW_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription =
    'Supplies Signal credentials to the workflow plugin (local signal-cli REST API).';

  static async start(runtime: IAgentRuntime): Promise<SignalWorkflowCredentialProvider> {
    return new SignalWorkflowCredentialProvider(runtime);
  }

  async stop(): Promise<void> {}

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    if (credType !== 'httpHeaderAuth') return null;
    const httpUrl = this.runtime.getSetting('SIGNAL_HTTP_URL') as string | undefined;
    const accountNumber = this.runtime.getSetting('SIGNAL_ACCOUNT_NUMBER') as string | undefined;
    if (!httpUrl?.trim() || !accountNumber?.trim()) return null;
    // Signal REST API is unauthenticated by default; supply the account number and base URL as sentinels.
    return {
      status: 'credential_data',
      data: {
        name: 'X-Signal-Account',
        value: accountNumber.trim(),
        signalHttpUrl: httpUrl.trim(),
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
