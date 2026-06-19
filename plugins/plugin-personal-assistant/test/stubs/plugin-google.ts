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

export const googlePlugin = {
  name: "google",
  description: "Google connector test double",
  init: async () => undefined,
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
