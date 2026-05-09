import { type IAgentRuntime, Service } from "@elizaos/core";

// Inlined to avoid adding @elizaos/plugin-workflow as a compile-time dependency.
// The runtime duck-types the service — only the serviceType string and resolve() shape matter.
const WORKFLOW_CREDENTIAL_PROVIDER_TYPE = "workflow_credential_provider";
type CredentialProviderResult =
  | { status: "credential_data"; data: Record<string, unknown> }
  | { status: "needs_auth"; authUrl: string }
  | null;

const SUPPORTED = ["slackApi", "slackOAuth2Api"];

export class SlackWorkflowCredentialProvider extends Service {
  static override readonly serviceType = WORKFLOW_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription =
    "Supplies Slack credentials to the workflow plugin.";

  static async start(
    runtime: IAgentRuntime,
  ): Promise<SlackWorkflowCredentialProvider> {
    return new SlackWorkflowCredentialProvider(runtime);
  }

  async stop(): Promise<void> {}

  async resolve(
    _userId: string,
    credType: string,
  ): Promise<CredentialProviderResult> {
    // slackApi takes a bot token (xoxb-) for the legacy credential type.
    // slackOAuth2Api takes a user OAuth token (xoxp-) — NOT the Socket Mode app token (xapp-).
    // SLACK_APP_TOKEN is xapp- and only usable for Socket Mode WebSocket connections; it has no
    // API scopes, so wiring it as an OAuth2 access token would yield invalid_auth at execution.
    const botToken = this.runtime.getSetting("SLACK_BOT_TOKEN") as
      | string
      | undefined;
    const userToken = this.runtime.getSetting("SLACK_USER_TOKEN") as
      | string
      | undefined;
    if (credType === "slackApi" && botToken?.trim()) {
      return {
        status: "credential_data",
        data: { accessToken: botToken.trim() },
      };
    }
    if (credType === "slackOAuth2Api" && userToken?.trim()) {
      return {
        status: "credential_data",
        data: { accessToken: userToken.trim() },
      };
    }
    return null;
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
