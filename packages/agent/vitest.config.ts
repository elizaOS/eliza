import { defineConfig, mergeConfig } from "vitest/config";
import { project } from "vibestack/testing/vitest";

const configure = project({ root: import.meta.dirname });

export default defineConfig(async (environment) => mergeConfig(await configure(environment), {
  test: { globalSetup: "./test/support/child.ts" },
}));
