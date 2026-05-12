import type {
  MediaAttachment,
  PlatformPostOptions,
  PostContent,
  PostResult,
  SocialCredentials,
  SocialMediaProvider,
} from "@/lib/types/social-media";
import { extractErrorMessage } from "@/lib/utils/error-handling";
import { logger } from "@/lib/utils/logger";
import { withRetry } from "../rate-limit";

const SLACK_API_BASE = "https://slack.com/api";

interface SlackResponse<_T = unknown> {
  ok: boolean;
  error?: string;
  warning?: string;
  response_metadata?: {
    next_cursor?: string;
  };
  [key: string]: unknown;
}

interface SlackMessage {
  ts: string;
  channel: string;
  text?: string;
}

interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  profile?: {
    image_72?: string;
    display_name?: string;
  };
}

interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
    emoji?: boolean;
  };
  accessory?: unknown;
  elements?: unknown[];
  image_url?: string;
  alt_text?: string;
}

async function slackApiRequest<T>(
  method: string,
  botToken: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const { data } = await withRetry<SlackResponse<T>>(
    () =>
      fetch(`${SLACK_API_BASE}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${botToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    async (response) => {
      const json = (await response.json()) as SlackResponse<T>;
      if (!json.ok) {
        throw new Error(json.error ?? "Slack API error");
      }
      return json;
    },
    { platform: "slack", maxRetries: 3 },
  );

  return data as T;
}

async function sendWebhook(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Slack webhook error: ${response.status} - ${text}`);
  }
}

function parsePostId(
  postId: string,
  fallbackChannel?: string,
): { channel: string | undefined; ts: string } {
  if (postId.includes("/")) {
    const [channel, ts] = postId.split("/");
    return { channel, ts };
  }
  return { channel: fallbackChannel, ts: postId };
}

function buildBlocks(content: PostContent): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  if (content.text) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: content.text },
    });
  }

  if (content.media?.length) {
    for (const media of content.media) {
      if (media.type === "image" && media.url) {
        blocks.push({
          type: "image",
          image_url: media.url,
          alt_text: media.altText ?? "Image",
        });
      }
    }
  }

  if (content.link) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<${content.link}|${content.linkTitle ?? content.link}>`,
      },
    });
  }

  return blocks;
}

export const slackProvider: SocialMediaProvider = {
  platform: "slack",

  async validateCredentials(credentials: SocialCredentials) {
    if (credentials.webhookUrl) {
      if (!credentials.webhookUrl.startsWith("https://hooks.slack.com/")) {
        return { valid: false, error: "Invalid Slack webhook URL" };
      }
      return { valid: true, accountId: "webhook", username: "Slack Webhook" };
    }

    if (!credentials.botToken) {
      return { valid: false, error: "Bot token or webhook URL required" };
    }

    try {
      const response = await slackApiRequest<SlackResponse & { user: SlackUser }>(
        "auth.test",
        credentials.botToken,
      );

      return {
        valid: true,
        accountId: response.user?.id ?? ((response as Record<string, unknown>).user_id as string),
        username: response.user?.name ?? ((response as Record<string, unknown>).user as string),
        displayName: response.user?.real_name,
      };
    } catch (error) {
      return {
        valid: false,
        error: extractErrorMessage(error),
      };
    }
  },

  async createPost(
    credentials: SocialCredentials,
    content: PostContent,
    options?: PlatformPostOptions,
  ): Promise<PostResult> {
    try {
      logger.info("[Slack] Creating post", {
        hasWebhook: !!credentials.webhookUrl,
      });

      if (credentials.webhookUrl) {
        const payload: Record<string, unknown> = {
          text: content.text,
        };

        const blocks = buildBlocks(content);
        if (blocks.length > 0) {
          payload.blocks = blocks;
        }

        await sendWebhook(credentials.webhookUrl, payload);

        // Webhook posts don't return message IDs - can't be deleted or referenced
        return {
          platform: "slack",
          success: true,
          postId: `webhook-${Date.now()}`,
          metadata: { type: "webhook", deletable: false },
        };
      }

      if (!credentials.botToken) {
        return {
          platform: "slack",
          success: false,
          error: "Bot token or webhook URL required",
        };
      }

      const channelId =
        options?.slack?.channelId ?? options?.discord?.channelId ?? credentials.channelId;
      if (!channelId) {
        return {
          platform: "slack",
          success: false,
          error: "Channel ID required for bot posting",
        };
      }

      const payload: Record<string, unknown> = {
        channel: channelId,
        text: content.text,
      };
      const blocks = buildBlocks(content);
      if (blocks.length > 0) payload.blocks = blocks;
      if (content.replyToId) payload.thread_ts = content.replyToId;

      const response = await slackApiRequest<
        SlackResponse & { message: SlackMessage; channel: string }
      >("chat.postMessage", credentials.botToken, payload);

      return {
        platform: "slack",
        success: true,
        postId: response.message?.ts ?? (response.ts as string),
        postUrl: `https://slack.com/archives/${response.channel}/p${(response.message?.ts ?? (response.ts as string)).replace(".", "")}`,
        metadata: { channel: response.channel },
      };
    } catch (error) {
      logger.error("[Slack] Post failed", { error });
      return {
        platform: "slack",
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },

  async deletePost(credentials: SocialCredentials, postId: string) {
    if (!credentials.botToken) {
      return { success: false, error: "Bot token required for deletion" };
    }

    const { channel, ts } = parsePostId(postId, credentials.channelId);
    if (!channel) {
      return {
        success: false,
        error: "Channel ID required (use channelId/ts format or set channel in credentials)",
      };
    }

    try {
      await slackApiRequest("chat.delete", credentials.botToken, {
        channel,
        ts,
      });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },

  async replyToPost(
    credentials: SocialCredentials,
    postId: string,
    content: PostContent,
    options?: PlatformPostOptions,
  ): Promise<PostResult> {
    const fallbackChannel = options?.slack?.channelId ?? credentials.channelId;
    const { channel, ts: threadTs } = parsePostId(postId, fallbackChannel);

    if (!channel) {
      return {
        platform: "slack",
        success: false,
        error: "Channel ID required for replies",
      };
    }

    return this.createPost(
      credentials,
      { ...content, replyToId: threadTs },
      { ...options, slack: { ...options?.slack, channelId: channel } },
    );
  },

  async likePost(credentials: SocialCredentials, postId: string) {
    if (!credentials.botToken) {
      return { success: false, error: "Bot token required" };
    }

    const { channel, ts: timestamp } = parsePostId(postId, credentials.channelId);
    if (!channel) {
      return { success: false, error: "Channel ID required" };
    }

    try {
      await slackApiRequest("reactions.add", credentials.botToken, {
        channel,
        timestamp,
        name: "thumbsup",
      });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },

  async uploadMedia(credentials: SocialCredentials, media: MediaAttachment) {
    if (!credentials.botToken) throw new Error("Bot token required");

    let fileData: Buffer;
    let filename = "upload";

    if (media.data) {
      fileData = media.data;
    } else if (media.base64) {
      fileData = Buffer.from(media.base64, "base64");
    } else if (media.url) {
      const response = await fetch(media.url);
      fileData = Buffer.from(await response.arrayBuffer());
      const urlParts = media.url.split("/");
      filename = urlParts[urlParts.length - 1].split("?")[0] || filename;
    } else {
      throw new Error("No media data provided");
    }

    const fileBytes = Uint8Array.from(fileData);
    const formData = new FormData();
    formData.append("file", new Blob([fileBytes], { type: media.mimeType }), filename);
    formData.append("filename", filename);

    const response = await fetch(`${SLACK_API_BASE}/files.upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.botToken}`,
      },
      body: formData,
    });

    const data = (await response.json()) as SlackResponse & {
      file: { id: string; permalink: string };
    };

    if (!data.ok) {
      throw new Error(data.error ?? "File upload failed");
    }

    return {
      mediaId: data.file.id,
      url: data.file.permalink,
    };
  },
};
