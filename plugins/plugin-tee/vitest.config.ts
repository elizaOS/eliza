/** Vitest config for plugin-tee: points tests at agent source seams and runs src test files. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentSrc = path.resolve(here, "../../packages/agent/src");

export default defineConfig({
  // Resolve the host boot-gate seam + evidence/policy contract to agent source
  // so the confidential-provider tests run without a prior agent dist build.
  resolve: {
    alias: [
      {
        find: /^@elizaos\/agent\/(.+)$/,
        replacement: path.join(agentSrc, "$1"),
      },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "**/node_modules/**"],
  },
});
