import { composePrompt, type IAgentRuntime, ModelType } from "@elizaos/core";
import type { BlueSkyClient } from "../client";
import { generateDmTemplate } from "../generated/prompts/typescript/prompts.js";
import type { BlueSkyConversation, BlueSkyMessage } from "../types";

export class BlueSkyMessageService {
  static serviceType = "IMessageService";

  constructor(
    private readonly client: BlueSkyClient,
    private readonly runtime: IAgentRuntime
  ) {}

  async getMessages(convoId: string, limit = 50): Promise<BlueSkyMessage[]> {
    const response = await this.client.getMessages(convoId, limit);
    return response.messages;
  }

  async sendMessage(convoId: string, text: string): Promise<BlueSkyMessage> {
    const messageText = text.trim() || (await this.generateReply());
    return this.client.sendMessage({ convoId, message: { text: messageText } });
  }

  async getConversations(limit = 50): Promise<BlueSkyConversation[]> {
    const response = await this.client.getConversations(limit);
    return response.conversations;
  }

  private async generateReply(): Promise<string> {
    const prompt = composePrompt({
      state: {},
      template: generateDmTemplate,
    });
    const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      maxTokens: 50,
    });
    return response as string;
  }
}
