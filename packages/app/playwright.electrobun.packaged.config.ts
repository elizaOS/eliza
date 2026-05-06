import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/electrobun-packaged",
  testMatch: ["**/*.e2e.spec.ts"],
  testIgnore:
    process.platform === "win32"
      ? []
      : ["**/electrobun-windows-startup.e2e.spec.ts"],
  timeout: 600_000,
  expect: {
    timeout: 30_000,
  },
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
