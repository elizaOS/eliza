import { project } from "vibestack/testing/vitest";

export default project({
  root: import.meta.dirname,
  plugins: [{
    name: "notes-browser-dependencies",
    config: () => ({
      optimizeDeps: { include: ["@effect/vitest", "effect", "vibelang-runtime/internal"] },
    }),
  }],
});
