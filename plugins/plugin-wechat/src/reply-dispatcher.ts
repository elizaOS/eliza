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
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
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
    if (text.length <= this.chunkSize) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

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

      chunks.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).trimStart();
    }

    return chunks;
  }
}
