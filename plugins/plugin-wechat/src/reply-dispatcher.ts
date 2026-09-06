/**
 * Outbound send path for WeChat replies: splits long text into
 * platform-size-limited chunks (Unicode-safe) and sends each chunk through the
 * first-party API transport.
 */
import {
  ElizaError,
  toWellFormedUnicode,
  truncateWellFormed,
} from "@elizaos/core";
import { WechatError } from "./types";

const DEFAULT_CHUNK_SIZE = 2000;

/** Minimal outbound transport the dispatcher needs (implemented by the API client). */
export interface WechatOutboundTransport {
  sendText: (to: string, text: string) => Promise<void>;
  sendImage?: (
    to: string,
    imagePath: string,
    caption?: string,
  ) => Promise<void>;
}

export interface ReplyDispatcherOptions {
  client: WechatOutboundTransport;
  chunkSize?: number;
}

export class ReplyDispatcher {
  private readonly client: WechatOutboundTransport;
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
        // error-policy:J2 the send failure is wrapped in the typed send
        // error with destination context and the original cause preserved.
        throw new WechatError(
          "WECHAT_SEND_FAILED",
          "chunked text delivery to the first-party endpoint failed",
          { to, chunkLength: chunk.length },
          { cause: err },
        );
      }
    }
  }

  async sendImage(
    to: string,
    imagePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.client.sendImage) {
      throw new ElizaError(
        "WeChat image sending is not available on this transport",
        { code: "WECHAT_SEND_FAILED", context: { to } },
      );
    }
    try {
      await this.client.sendImage(to, imagePath, caption);
    } catch (err) {
      // error-policy:J2 the send failure is wrapped in the typed send
      // error with destination context and the original cause preserved.
      throw new WechatError(
        "WECHAT_SEND_FAILED",
        "image delivery to the first-party endpoint failed",
        { to, imagePath },
        { cause: err },
      );
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
      remaining = remaining.slice(cutPoint);
    }

    return chunks;
  }
}
