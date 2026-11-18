/** Controlled browser/host/relay evidence; uses no LIVE profile or remote provider. */
import { defineConfig } from "vitest/config";
import hostConfig from "./vitest.host.config.ts";

export default defineConfig({
  ...hostConfig,
  test: {
    ...hostConfig.test,
    include: ["test/app/voice-renewal.real.e2e.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 600_000,
  },
});
