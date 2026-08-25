/**
 * Outbound send path for WeChat replies: splits long text into proxy-safe chunks
 * and sends each chunk (and images) through the `ProxyClient`.
 */
import {
  ElizaError,
  toWellFormedUnicode,
  truncateWellFormed,
} from "@elizaos/core";
import type { ProxyClient } from "./proxy-client";

const DEFAULT_CHUNK_SIZE = 2000;

export interface ReplyDispatcherOptions {
  client: ProxyClient;
  chunkSize?: number;
}

export class ReplyDispatcher {
  private readonly client: ProxyClient;
  private readonly chunkSize: number;

  constructor(options: ReplyDispatcherOptions) {
    this.client = options.client;
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
      throw new ElizaError(
        "WeChat reply chunk size must be a positive integer",
        {
          code: "WECHAT_REPLY_CHUNK_SIZE_INVALID",
          context: { chunkSize },
        },
      );
    }
    this.chunkSize = chunkSize;
  }

  async sendText(to: string, text: string): Promise<void> {
    const chunks = this.chunk(text);
    for (const chunk of chunks) {
      try {
        await this.client.sendText(to, chunk);
      } catch (err) {
        console.error(`[wechat] Failed to send text to ${to}:`, err);
        throw err;
      }
    }
  }

  async sendImage(
    to: string,
    imagePath: string,
    caption?: string,
  ): Promise<void> {
    try {
      await this.client.sendImage(to, imagePath, caption);
    } catch (err) {
      console.error(`[wechat] Failed to send image to ${to}:`, err);
      throw err;
    }
  }

  private chunk(text: string): string[] {
    const wellFormedText = toWellFormedUnicode(text);
    if (wellFormedText.length <= this.chunkSize) {
      return [wellFormedText];
    }

    const chunks: string[] = [];
    let remaining = wellFormedText;

    while (remaining.length > 0) {
      if (remaining.length <= this.chunkSize) {
        chunks.push(remaining);
        break;
      }

      // Try to break at a newline
      let breakAt = remaining.lastIndexOf("\n", this.chunkSize);
      if (breakAt <= 0) {
        // Try to break at a space
        breakAt = remaining.lastIndexOf(" ", this.chunkSize);
      }
      if (breakAt <= 0) {
        // Hard break
        breakAt = this.chunkSize;
      }

      const chunkCandidate = truncateWellFormed(remaining, breakAt);
      if (chunkCandidate.length === 0) {
        throw new ElizaError(
          "WeChat reply chunk size cannot fit the next Unicode character",
          {
            code: "WECHAT_REPLY_CHUNK_SIZE_TOO_SMALL",
            context: { chunkSize: this.chunkSize },
          },
        );
      }
      const cutPoint = chunkCandidate.length;
      chunks.push(remaining.slice(0, cutPoint));
      remaining = remaining.slice(cutPoint).trimStart();
    }

    return chunks;
  }
}
