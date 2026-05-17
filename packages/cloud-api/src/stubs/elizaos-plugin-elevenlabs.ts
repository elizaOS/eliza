const elevenLabsPlugin = {
  name: "elevenlabs",
  description:
    "ElevenLabs plugin is loaded by the agent-server sidecar, not the Cloudflare Worker API bundle.",
};

export { elevenLabsPlugin };
export default elevenLabsPlugin;
