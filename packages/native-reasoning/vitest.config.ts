import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/__tests__/loop.test.ts",
      "src/__tests__/system-prompt.test.ts",
      "src/__tests__/spawn_codex.test.ts",
      "src/__tests__/tools.test.ts",
      "src/__tests__/tool-format-openai.test.ts",
      "src/__tests__/sse-parser.test.ts",
      "src/__tests__/codex-auth.test.ts",
      "src/__tests__/backend-codex.test.ts",
      "src/__tests__/backends.test.ts",
    ],
  },
});
