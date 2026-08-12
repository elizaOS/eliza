/**
 * Test stub for the Google plugin: a minimal message-adapter-shaped plugin used when
 * LifeOps tests exercise Gmail/Calendar projections without live Google.
 */
import type {
  DraftRequest,
  IAgentRuntime,
  ListOptions,
  ManageOperation,
  ManageResult,
  MessageAdapter,
  MessageAdapterCapabilities,
  MessageRef,
  SearchMessagesFilters,
} from "@elizaos/core";
import { Service } from "@elizaos/core";

export {
  assessGoogleOAuthCallbackConfig,
  assertCanonicalGoogleOAuthRedirectUri,
  GOOGLE_CONNECTOR_OAUTH_CALLBACK_PATH,
  isPortlessLoopbackRedirectUrl,
  resolveGoogleConnectorOAuthCallbackUrl,
} from "../../../plugin-google-workspace/src/google-oauth-callback.ts";

export class GoogleWorkspaceTestService extends Service {
  static serviceType = "google";

  capabilityDescription =
    "Test Google Workspace service requiring explicit per-test method stubs";

  static async start(
    runtime: IAgentRuntime,
  ): Promise<GoogleWorkspaceTestService> {
    return new GoogleWorkspaceTestService(runtime);
  }

  async stop(): Promise<void> {}

  async createEvent(_input: {
    calendarId?: string;
    title: string;
    start: string;
    end: string;
    timeZone?: string;
    description?: string;
    location?: string;
  }): Promise<never> {
    throw new Error("Google calendar createEvent is not stubbed for this test");
  }
}

export const googlePlugin = {
  name: "google",
  description: "Google connector test double",
  init: async () => undefined,
  services: [GoogleWorkspaceTestService],
};

export class GoogleGmailAdapter implements MessageAdapter {
  readonly source = "gmail";

  isAvailable(_runtime: IAgentRuntime): boolean {
    return false;
  }

  capabilities(): MessageAdapterCapabilities {
    return {
      list: false,
      search: false,
      manage: false,
      draft: false,
      send: false,
      scheduleSend: false,
    };
  }

  async listMessages(
    _runtime: IAgentRuntime,
    _opts: ListOptions,
  ): Promise<MessageRef[]> {
    return [];
  }

  async getMessage(
    _runtime: IAgentRuntime,
    _id: string,
  ): Promise<MessageRef | null> {
    return null;
  }

  async searchMessages(
    _runtime: IAgentRuntime,
    _filters: SearchMessagesFilters,
  ): Promise<MessageRef[]> {
    return [];
  }

  async manageMessage(
    _runtime: IAgentRuntime,
    _messageId: string,
    _op: ManageOperation,
  ): Promise<ManageResult> {
    return { ok: false, reason: "gmail adapter unavailable in test runtime" };
  }

  async createDraft(
    _runtime: IAgentRuntime,
    _draft: DraftRequest,
  ): Promise<{ draftId: string; preview: string }> {
    throw new Error("gmail adapter unavailable in test runtime");
  }

  async sendDraft(
    _runtime: IAgentRuntime,
    _draftId: string,
  ): Promise<{ externalId: string }> {
    throw new Error("gmail adapter unavailable in test runtime");
  }
}

export default googlePlugin;
