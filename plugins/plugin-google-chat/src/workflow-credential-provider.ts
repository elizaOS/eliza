import { promises as fs } from "node:fs";
import { type IAgentRuntime, logger, Service } from "@elizaos/core";

// Inlined to avoid adding @elizaos/plugin-workflow as a compile-time dependency.
// The runtime duck-types the service — only the serviceType string and resolve() shape matter.
const WORKFLOW_CREDENTIAL_PROVIDER_TYPE = "workflow_credential_provider";
type CredentialProviderResult =
  | { status: "credential_data"; data: Record<string, unknown> }
  | { status: "needs_auth"; authUrl: string }
  | null;

const SUPPORTED = ["googleChatOAuth2Api"];

export class GoogleChatWorkflowCredentialProvider extends Service {
  static override readonly serviceType = WORKFLOW_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription = "Supplies Google Chat credentials to the workflow plugin.";

  static async start(runtime: IAgentRuntime): Promise<GoogleChatWorkflowCredentialProvider> {
    return new GoogleChatWorkflowCredentialProvider(runtime);
  }

  async stop(): Promise<void> {}

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    if (credType !== "googleChatOAuth2Api") return null;
    const inlineJson = (
      this.runtime.getSetting("GOOGLE_CHAT_SERVICE_ACCOUNT") as string | undefined
    )?.trim();
    const filePath =
      (this.runtime.getSetting("GOOGLE_CHAT_SERVICE_ACCOUNT_FILE") as string | undefined)?.trim() ||
      (this.runtime.getSetting("GOOGLE_APPLICATION_CREDENTIALS") as string | undefined)?.trim();

    let serviceAccountKey: string | undefined;
    if (inlineJson) {
      try {
        JSON.parse(inlineJson);
        serviceAccountKey = inlineJson;
      } catch {
        logger.warn(
          `[GoogleChat] GOOGLE_CHAT_SERVICE_ACCOUNT is not valid JSON — did you mean to set GOOGLE_CHAT_SERVICE_ACCOUNT_FILE instead?`
        );
        return null;
      }
    } else if (filePath) {
      try {
        const content = await fs.readFile(filePath, "utf-8");
        JSON.parse(content);
        serviceAccountKey = content;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[GoogleChat] Failed to read service account file at ${filePath}: ${message}`);
        return null;
      }
    }

    if (!serviceAccountKey) return null;
    return {
      status: "credential_data",
      data: { serviceAccountKey },
    };
  }

  checkCredentialTypes(credTypes: string[]): { supported: string[]; unsupported: string[] } {
    return {
      supported: credTypes.filter((t) => SUPPORTED.includes(t)),
      unsupported: credTypes.filter((t) => !SUPPORTED.includes(t)),
    };
  }
}
