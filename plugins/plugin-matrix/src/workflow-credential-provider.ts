import { type IAgentRuntime, Service } from "@elizaos/core";

// Inlined to avoid adding @elizaos/plugin-workflow as a compile-time dependency.
// The runtime duck-types the service — only the serviceType string and resolve() shape matter.
const WORKFLOW_CREDENTIAL_PROVIDER_TYPE = "workflow_credential_provider";
type CredentialProviderResult =
  | { status: "credential_data"; data: Record<string, unknown> }
  | { status: "needs_auth"; authUrl: string }
  | null;

const SUPPORTED = ["matrixApi"];

export class MatrixWorkflowCredentialProvider extends Service {
  static override readonly serviceType = WORKFLOW_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription = "Supplies Matrix credentials to the workflow plugin.";

  static async start(runtime: IAgentRuntime): Promise<MatrixWorkflowCredentialProvider> {
    return new MatrixWorkflowCredentialProvider(runtime);
  }

  async stop(): Promise<void> {}

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    if (credType !== "matrixApi") return null;
    const accessToken = this.runtime.getSetting("MATRIX_ACCESS_TOKEN") as string | undefined;
    const homeserver = this.runtime.getSetting("MATRIX_HOMESERVER") as string | undefined;
    if (!accessToken?.trim() || !homeserver?.trim()) return null;
    return {
      status: "credential_data",
      data: { accessToken: accessToken.trim(), homeserverUrl: homeserver.trim() },
    };
  }

  checkCredentialTypes(credTypes: string[]): { supported: string[]; unsupported: string[] } {
    return {
      supported: credTypes.filter((t) => SUPPORTED.includes(t)),
      unsupported: credTypes.filter((t) => !SUPPORTED.includes(t)),
    };
  }
}
