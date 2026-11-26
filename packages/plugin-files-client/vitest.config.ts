import { project } from "vibestack/testing/vitest";
import vibelang from "vibelang-vite";

export default project({
  root: import.meta.dirname,
  plugins: [{
    name: "files-browser-dependencies",
    config: () => ({
      worker: { format: "es", plugins: () => [vibelang()] },
      optimizeDeps: {
        include: [
          "@capacitor/core",
          "@effect/vitest",
          "effect/Cause",
          "effect/Clock",
          "effect/Effect",
          "effect/Exit",
          "effect/Layer",
          "effect/Ref",
          "effect/Schema",
          "effect/Semaphore",
          "effect/Stream",
          "effect/SubscriptionRef",
          "effect/persistence/KeyValueStore",
          "effect/testing/TestClock",
          "pdf-lib",
          "vibelang-runtime/internal",
        ],
      },
    }),
  }],
});
