import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4000",
    trace: "retain-on-failure",
    viewport: {
      height: 1000,
      width: 1440,
    },
  },
  webServer: {
    command: "npx vite --port 4000",
    env: {
      VITE_E2E_DISABLE_VRM: "1",
    },
    port: 4000,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
