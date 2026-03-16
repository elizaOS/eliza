import { composePrompt, type IAgentRuntime, ModelType } from "@elizaos/core";
import type { BlueSkyClient } from "../client";
import {
  generatePostTemplate,
  truncatePostTemplate,
} from "../generated/prompts/typescript/prompts.js";
import type { BlueSkyPost, CreatePostRequest } from "../types";
import { BLUESKY_MAX_POST_LENGTH } from "../types";

export class BlueSkyPostService {
  static serviceType = "IPostService";

  constructor(
    private readonly client: BlueSkyClient,
    private readonly runtime: IAgentRuntime
  ) {}

  async getPosts(limit = 50, cursor?: string): Promise<BlueSkyPost[]> {
    const response = await this.client.getTimeline({ limit, cursor });
    return response.feed.map((item) => item.post);
  }

  async createPost(text: string, replyTo?: { uri: string; cid: string }): Promise<BlueSkyPost> {
    let postText = text.trim() || (await this.generateContent());

    if (postText.length > BLUESKY_MAX_POST_LENGTH) {
      postText = await this.truncate(postText);
    }

    const request: CreatePostRequest = {
      content: { text: postText },
      replyTo,
    };

    return this.client.sendPost(request);
  }

  async deletePost(uri: string): Promise<void> {
    await this.client.deletePost(uri);
  }

  private async generateContent(): Promise<string> {
    const prompt = composePrompt({
      state: {
        maxLength: String(BLUESKY_MAX_POST_LENGTH),
      },
      template: generatePostTemplate,
    });
    const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      maxTokens: 100,
    });
    return response as string;
  }

  private async truncate(text: string): Promise<string> {
    const prompt = composePrompt({
      state: {
        maxLength: String(BLUESKY_MAX_POST_LENGTH),
        text,
      },
      template: truncatePostTemplate,
    });
    const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      maxTokens: 100,
    });
    const truncated = response as string;
    return truncated.length > BLUESKY_MAX_POST_LENGTH
      ? `${truncated.substring(0, BLUESKY_MAX_POST_LENGTH - 3)}...`
      : truncated;
  }
}
