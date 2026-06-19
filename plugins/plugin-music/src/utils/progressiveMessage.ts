import type { HandlerCallback } from "@elizaos/core";

/**
 * Lightweight progress-update helper compatible with the ProgressiveMessage
 * API from @elizaos/plugin-discord.
 *
 * On Discord the upstream version edits a single message in-place. On the
 * Eliza web chat, the API server's SSE handler uses snapshot/replace
 * semantics for action callbacks — each callback call replaces the previous
 * callback text rather than appending. This gives the same edit-in-place UX:
 * the user sees "🔍 Searching…" → "✨ Setting up…" → "Now playing: **X**"
 * all in the same chat bubble.
 *
 * The contract matches plugin-discord: call update() for transient status,
 * complete()/fail() for the final result. All methods invoke the callback.
 */
export class ProgressiveMessage {
  private callback: HandlerCallback;
  private source: string;

  constructor(callback: HandlerCallback, source = "discord") {
    this.callback = callback;
    this.source = source;
  }

  update(text: string, _opts?: { important?: boolean }): void {
    void this.callback({
      text,
      source: this.source,
      merge: "replace",
    });
  }

  async fail(text: string): Promise<void> {
    await this.callback({
      text,
      source: this.source,
      merge: "replace",
    });
  }

  async finish(text: string): Promise<void> {
    await this.callback({
      text,
      source: this.source,
      merge: "replace",
    });
  }

  async complete(text: string): Promise<void> {
    await this.callback({
      text,
      source: this.source,
      merge: "replace",
    });
  }
}
