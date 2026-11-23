import { project } from "vibestack/testing/vitest";

export default project({
  root: import.meta.dirname,
  plugins: [{
    name: "calendar-agent-source",
    config: () => ({
      ssr: {
        noExternal: ["@elizaos/agent"],
        resolve: { conditions: ["node", "development|production", "eliza-source"] },
      },
    }),
  }],
});
