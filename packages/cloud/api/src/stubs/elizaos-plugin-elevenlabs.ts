/** Speech models execute on the agent sidecar; the Worker cannot register them. */
const elevenLabsPlugin = {
  name: "elevenlabs",
  description: "ElevenLabs requires the agent-server sidecar.",
  async init(): Promise<never> {
    throw new Error(
      "ElevenLabs is not available in the Cloudflare Worker; initialize it on the agent-server sidecar",
    );
  },
};

export { elevenLabsPlugin };
export default elevenLabsPlugin;
