/** Vitest config for the streaming plugin's node-environment unit tests. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
  },
});
