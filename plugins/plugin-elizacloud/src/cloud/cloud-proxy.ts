/**
 * Drop-in replacement for a local AgentRuntime when running in cloud mode.
 * Routes chat/status calls through the ElizaCloudClient to the remote sandbox.
 */

import {
  CloudBridgeError,
  type ChatChannelType,
  type ElizaCloudClient,
} from "./bridge-client.js";

export class CloudRuntimeProxy {
  constructor(
    private client: ElizaCloudClient,
    private agentId: string,
    private _agentName: string,
  ) {}

  get agentName(): string {
    return this._agentName;
  }

  async handleChatMessage(
    text: string,
    roomId = "web-chat",
    channelType: ChatChannelType = "DM",
  ): Promise<string> {
    return this.client.sendMessage(this.agentId, text, roomId, channelType);
  }

  async *handleChatMessageStream(
    text: string,
    roomId = "web-chat",
    channelType: ChatChannelType = "DM",
  ): AsyncGenerator<string> {
    // Text already yielded to the caller. Chunks may carry a delta (`text`),
    // a cumulative snapshot (`fullText`), or both; `done` may carry the final
    // reply. Only the part not yet shown is yielded.
    let shown = "";
    const unseenSuffix = (snapshot: string): string =>
      snapshot.startsWith(shown) ? snapshot.slice(shown.length) : "";
    for await (const event of this.client.sendMessageStream(
      this.agentId,
      text,
      roomId,
      channelType,
    )) {
      if (event.type === "chunk") {
        const { text: delta, fullText } = event.data;
        let next = "";
        if (typeof fullText === "string") next = unseenSuffix(fullText);
        else if (typeof delta === "string") next = delta;
        if (next.length > 0) {
          shown += next;
          yield next;
        }
      } else if (event.type === "done") {
        const { text: doneText, fullText } = event.data;
        const finalText =
          typeof fullText === "string"
            ? fullText
            : typeof doneText === "string"
              ? doneText
              : null;
        if (finalText !== null) {
          const next = unseenSuffix(finalText);
          if (next.length > 0) {
            shown += next;
            yield next;
          }
        }
      }
    }
    if (shown.length === 0) {
      throw new CloudBridgeError("Cloud stream ended without reply text");
    }
  }

  async getStatus(): Promise<{ state: string; agentName: string }> {
    const agent = await this.client.getAgent(this.agentId);
    return { state: agent.status, agentName: agent.agentName };
  }

  async isAlive(): Promise<boolean> {
    return this.client.heartbeat(this.agentId).catch(() => false);
  }
}
