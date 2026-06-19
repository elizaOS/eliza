import { type IAgentRuntime, Service } from "@elizaos/core";

// Inlined to avoid adding @elizaos/plugin-workflow as a compile-time dependency.
// The runtime duck-types the service — only the serviceType string and resolve() shape matter.
const WORKFLOW_CREDENTIAL_PROVIDER_TYPE = "workflow_credential_provider";
type CredentialProviderResult =
  | { status: "credential_data"; data: Record<string, unknown> }
  | { status: "needs_auth"; authUrl: string }
  | null;

// Twitch's workflow node uses httpHeaderAuth with a Bearer token.
const SUPPORTED = ["httpHeaderAuth"];

export class TwitchWorkflowCredentialProvider extends Service {
  static override readonly serviceType = WORKFLOW_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription =
    "Supplies Twitch credentials to the workflow plugin.";

  static async start(
    runtime: IAgentRuntime,
  ): Promise<TwitchWorkflowCredentialProvider> {
    return new TwitchWorkflowCredentialProvider(runtime);
  }

  async stop(): Promise<void> {}

  async resolve(
    _userId: string,
    credType: string,
  ): Promise<CredentialProviderResult> {
    if (credType !== "httpHeaderAuth") return null;
    const accessToken = this.runtime.getSetting("TWITCH_ACCESS_TOKEN") as
      | string
      | undefined;
    if (!accessToken?.trim()) return null;
    return {
      status: "credential_data",
      data: { name: "Authorization", value: `Bearer ${accessToken.trim()}` },
    };
  }

  checkCredentialTypes(credTypes: string[]): {
    supported: string[];
    unsupported: string[];
  } {
    return {
      supported: credTypes.filter((t) => SUPPORTED.includes(t)),
      unsupported: credTypes.filter((t) => !SUPPORTED.includes(t)),
    };
  }
}
