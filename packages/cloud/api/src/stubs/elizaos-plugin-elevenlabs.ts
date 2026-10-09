/** Speech models execute on the agent sidecar; the Worker cannot register them. */
import { ElizaError } from "@elizaos/core/protocol";

const elevenLabsPlugin = {
  name: "elevenlabs",
  description: "ElevenLabs requires the agent-server sidecar.",
  async init(): Promise<never> {
    throw new ElizaError(
      "ElevenLabs is not available in the Cloudflare Worker; initialize it on the agent-server sidecar",
      { code: "WORKER_CAPABILITY_UNAVAILABLE" },
    );
  },
};

export { elevenLabsPlugin };
export default elevenLabsPlugin;
