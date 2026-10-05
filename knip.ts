/** Repository dead-code configuration. App entries derive from its public exports and published tooling contract. */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { KnipConfig } from "knip";
import { PUBLISH_ASSET_PATHS } from "./packages/app/scripts/copy-publish-assets.ts";

const config = {
  "github-actions": false,
  vite: false,
  vitest: false,
  rules: {
    duplicates: "off",
  },
  ignore: [
    ".github/**",
    "**/dist/**",
    "**/coverage/**",
    "**/storybook-static/**",
    "**/.turbo/**",
    "plugins/plugin-local-inference/native/llama.cpp/**",
    "plugins/plugin-local-inference/native/reports/**/*.json",
    "plugins/plugin-local-inference/native/verify/bench_results/**",
    "plugins/plugin-local-inference/native/verify/reports/**",
  ],
  ignoreBinaries: [
    "biome",
    "capacitor",
    "playwright",
    "rm",
    "tsc",
    "tsup",
    "tsx",
    "vite",
    "vitest",
    "make",
  ],
  ignoreDependencies: ["vitest", "vitest/config"],
  ignoreUnresolved: ["bun-types", "node:sqlite"],
  ignoreWorkspaces: ["."],
  workspaces: {
    "packages/cloud/routing": {
      entry: ["src/index.ts", "src/**/*.test.ts"],
      project: ["src/**/*.ts"],
      ignore: ["dist/**", ".turbo/**"],
    },
    "packages/cloud/sdk": {
      entry: [
        "src/index.ts",
        "src/**/*.test.ts",
        "src/**/*.e2e.test.ts",
        "build.ts",
        "vitest.live.config.ts",
        "scripts/**/*.ts",
      ],
      project: [
        "src/**/*.ts",
        "build.ts",
        "vitest.live.config.ts",
        "scripts/**/*.ts",
      ],
      ignore: ["dist/**", ".turbo/**"],
    },
    "packages/cloud/api": {
      entry: [
        "src/index.ts",
        "src/_generate-router.mjs",
        "src/stubs/**/*.ts",
        "__tests__/**/*.ts",
        "test/**/*.mjs",
        "test/**/*.ts",
      ],
      project: ["**/*.{ts,tsx}", "src/_generate-router.mjs", "test/**/*.mjs"],
      ignore: [".wrangler/**", "dist/**", ".turbo/**"],
      ignoreDependencies: ["wrangler"],
    },
    "packages/cloud/services/agent-server": {
      entry: ["src/index.ts", "src/**/*.ts", "__tests__/**/*.ts"],
      project: ["src/**/*.ts", "__tests__/**/*.ts"],
      ignore: ["dist/**", ".turbo/**"],
      ignoreDependencies: ["bun-types"],
    },
    "packages/cloud/services/gateway-discord": {
      entry: ["src/index.ts", "src/**/*.ts", "tests/**/*.ts"],
      project: ["src/**/*.ts", "tests/**/*.ts"],
      ignore: ["dist/**", ".turbo/**"],
      ignoreDependencies: ["bun-types"],
    },
    "packages/cloud/services/gateway-webhook": {
      entry: ["src/index.ts", "src/**/*.ts", "__tests__/**/*.ts"],
      project: ["src/**/*.ts", "__tests__/**/*.ts"],
      ignore: ["dist/**", ".turbo/**"],
      ignoreDependencies: ["bun-types"],
    },
    "packages/cloud/services/operator": {
      entry: ["pepr.ts"],
      project: ["pepr.ts", "capabilities/**/*.ts"],
      ignore: ["dist/**", ".turbo/**"],
      ignoreDependencies: ["@types/bun", "esbuild", "prettier", "uuid"],
    },
    "packages/cloud/shared": {
      entry: [
        "src/index.ts",
        "src/billing/index.ts",
        "src/db/index.ts",
        "src/lib/index.ts",
        "src/types/index.ts",
        "src/**/*.test.ts",
        "drizzle.config.ts",
      ],
      project: ["src/**/*.ts", "drizzle.config.ts"],
      ignore: ["dist/**", ".turbo/**"],
      ignoreDependencies: ["redis", "wadis"],
    },
    "packages/testing/scenario-runner": {
      entry: [
        "src/index.ts",
        "src/cli.ts",
        "src/runtime-factory.ts",
        "src/**/*.test.ts",
        "vitest.config.ts",
      ],
      project: ["src/**/*.ts", "vitest.config.ts"],
      ignore: ["dist/**", ".turbo/**"],
    },
    "packages/testing": {
      entry: [
        "src/index.ts",
        "src/**/*.test.ts",
        "scenarios/**/*.ts",
        "vitest.config.ts",
      ],
      project: ["src/**/*.ts", "scenarios/**/*.ts", "vitest.config.ts"],
      ignore: ["dist/**", ".turbo/**"],
    },
    "packages/auth": {
      entry: ["src/index.ts", "test/**/*.test.ts", "vitest.config.ts"],
      project: ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"],
      ignore: ["dist/**", ".turbo/**"],
    },
    "plugins/plugin-anthropic": {
      entry: [
        "index.ts",
        "index.node.ts",
        "index.browser.ts",
        "auto-enable.ts",
        "build.ts",
        "models/**/*.ts",
        "__tests__/**/*.test.ts",
        "vitest.config.ts",
        "vitest.live.config.ts",
      ],
      project: [
        "**/*.ts",
        "__tests__/**/*.test.ts",
        "vitest.config.ts",
        "vitest.live.config.ts",
      ],
      ignore: ["dist/**", ".turbo/**"],
    },
    "plugins/plugin-native-inference": {
      entry: [
        "src/index.ts",
        "src/aosp-mtp-adapter.ts",
        "src/aosp-llama-streaming.ts",
        "__tests__/**/*.test.ts",
      ],
      project: ["src/**/*.ts", "__tests__/**/*.ts"],
      ignore: ["dist/**", ".turbo/**"],
    },
    "plugins/plugin-agent-orchestrator": {
      entry: [
        "index.ts",
        "index.node.ts",
        "build.ts",
        "src/index.ts",
        "src/register-routes.ts",
        "src/**/*.test.ts",
        "__tests__/**/*.test.ts",
        "tests/**/*.mjs",
        "scripts/**/*.ts",
        "vitest.config.ts",
      ],
      project: [
        "*.ts",
        "src/**/*.ts",
        "__tests__/**/*.ts",
        "tests/**/*.mjs",
        "scripts/**/*.ts",
        "vitest.config.ts",
      ],
      ignore: ["dist/**", ".turbo/**"],
    },
    "packages/app": {
      entry: [
        "src/main.tsx",
        "src/renderer-entry.ts",
        "src/public-web-entry.tsx",
        "src/mobile-agent-entry.ts",
        "src/host-externals.ts",
        "src/plugin-registrations.ts",
        "src/shims/**/*.{ts,tsx}",
        "src/**/*.{test,spec}.{ts,tsx,mjs}",
        "app.config.ts",
        "capacitor.config.ts",
        "vite.config.ts",
        "vite-dev-origin.ts",
        "vitest*.config.ts",
        "playwright.*.config.ts",
        "scripts/**/*.{test,spec}.{ts,tsx,mjs}",
        // Device/workflow CLIs and subprocess entrypoints outside package scripts.
        "scripts/alpha-dstack.ts",
        "scripts/android-chromium-smoke.mjs",
        "scripts/android-gateway-lifecycle.ts",
        "scripts/android-native-agent.ts",
        "scripts/android-native-browser-smoke.mjs",
        "scripts/android-native-filesystem.ts",
        "scripts/android-native-sms.ts",
        "scripts/cloud-provisioning-e2e.ts",
        "scripts/link-docker-local-app-packages.ts",
        "scripts/onboarding-replay-evidence.ts",
        "scripts/playwright-ui-live-stack.ts",
        "scripts/release-check.ts",
        "scripts/run-release-check.ts",
        "scripts/visual-qa-report.ts",
        "scripts/voice-attribution-smoke.ts",
        "scripts/mobile/android/qualify-consumer-host.mjs",
        "scripts/android-native-plugins-gradle/bridge-tests/assets/contracts.ts",
        "test/**/*.{ts,tsx,mjs}",
        "e2e/**/*.{ts,tsx,mjs}",
        "platforms/electrobun/electrobun.config.ts",
        "platforms/electrobun/src/index.ts",
        "platforms/electrobun/src/bridge/electrobun-preload.ts",
      ],
      project: [
        "src/**/*.{ts,tsx}",
        "scripts/**/*.{ts,mjs}",
        "vite/**/*.ts",
        "*.ts",
        "test/**/*.{ts,tsx,mjs}",
      ],
      ignore: ["dist/**", "ios/**", "android/**"],
      ignoreDependencies: [
        "@capacitor/android",
        "@capacitor/barcode-scanner",
        "@capacitor/browser",
        "@capacitor/haptics",
        "@capacitor/ios",
        "@capacitor/push-notifications",
        "@elizaos/ui",
        "@pixiv/three-vrm",
        "llama-cpp-capacitor",
        "pathe",
        "tailwindcss",
        "three",
        "ws",
        "@capacitor/background-runner",
        "@capacitor/keyboard",
        "@capacitor/local-notifications",
        "@elizaos/plugin-anthropic",
        "@elizaos/plugin-personal-assistant",
        "@elizaos/plugin-openai",
        "@elizaos/plugin-wallet",
        "@elizaos/plugin-wechat",
        "electrobun",
      ],
      ignoreUnresolved: ["tsx"],
      ignoreBinaries: [
        "adb",
        "afconvert",
        "anvil",
        "brew",
        "cmake",
        "findstr",
        "hf",
        "log",
        "netstat",
        "ninja",
        "nm",
        "nvidia-smi",
        "otool",
        "pgrep",
        "rg",
        "ruby",
        "say",
        "secret-tool",
        "strip",
        "swift",
        "tsc6",
        "where",
        "winget",
      ],
    },
    "packages/app/deploy/cloud-agent-template": {
      entry: ["entrypoint.ts"],
      project: ["*.ts"],
      ignoreDependencies: [
        "@elizaos/core",
        "@elizaos/plugin-sql",
        "@elizaos/plugin-elizacloud",
        "@elizaos/plugin-workflow",
      ],
    },
    "packages/app/platforms/electrobun": {
      entry: [
        "src/**/*.{ts,tsx,js}",
        "electrobun.config.ts",
        "vitest.electrobun.config.ts",
        "scripts/**/*.ts",
      ],
      project: [
        "src/**/*.{ts,tsx,js}",
        "scripts/**/*.ts",
        "electrobun.config.ts",
        "vitest.electrobun.config.ts",
      ],
      ignore: ["build/**", "artifacts/**"],
      ignoreDependencies: ["bonjour-service", "rcedit"],
    },
    "plugins/plugin-native-gateway": {
      ignoreBinaries: ["pod"],
    },
    "plugins/plugin-native-activity-tracker": {
      ignoreBinaries: ["swiftc"],
    },
    "packages/agent": {
      entry: [
        "src/index.ts",
        "src/bin.ts",
        "src/services/agent-backup-restore-v3-controller-worker.ts",
        "src/services/agent-backup-restore-v3-restored-runtime.ts",
        "src/services/agent-backup-restore-v3-probe-client.ts",
        "scripts/**/*.ts",
        "test/**/*.{ts,tsx}",
        "vitest.config.ts",
      ],
      project: [
        "src/**/*.{ts,tsx}",
        "scripts/**/*.ts",
        "test/**/*.{ts,tsx}",
        "*.ts",
      ],
      ignore: ["dist/**", "dist-mobile*/**"],
      ignoreDependencies: [
        "@elizaos/plugin-cloud-apps",
        "@elizaos/plugin-imessage",
        "@elizaos/plugin-mcp",
        "@elizaos/plugin-notes",
        "@elizaos/plugin-whatsapp",
        "@elizaos/plugin-workflow",
        "node:sqlite",
        "ws",
        "@types/ws",
        "x402-fetch",
      ],
    },
    "packages/core": {
      entry: ["src/index.ts", "src/protocol.ts", "build.ts", "scripts/**/*.ts"],
      project: ["src/**/*.ts", "!src/**/*.d.ts", "build.ts"],
      ignoreDependencies: [
        "@ai-sdk/anthropic",
        "@ai-sdk/google",
        "@ai-sdk/openai",
        "@openrouter/ai-sdk-provider",
      ],
      ignoreUnresolved: [
        "./Action",
        "./Memory",
        "./Provider",
        "./Runtime",
        "./State",
      ],
      ignore: [
        "e2e/**",
        "test/**",
        "src/testing/**",
        "src/__tests__/**",
        "src/services/triggerScheduling.ts",
        "src/**/*.d.ts",
        "src/**/*.d.ts.map",
      ],
    },
    "plugins/plugin-tailscale": {
      entry: ["src/index.ts"],
      project: ["src/**/*.ts"],
    },
    "packages/ui": {
      entry: ["src/**/*.{css,ts,tsx}", "vitest.config.ts"],
      project: ["src/**/*.{css,ts,tsx}", "vitest.config.ts"],
      ignoreDependencies: [
        "@elizaos/core",
        "@elizaos/plugin-browser",
        "@capacitor/app",
        "jsdom",
        "node-llama-cpp",
        "three",
        "vite",
        "vite/client",
        "ws",
        "zod",
      ],
      ignore: ["dist/**", "storybook-static/**"],
    },
    "plugins/plugin-local-inference/native": {
      entry: ["scripts/**/*.ts", "verify/**/*.{mjs,ts}", "package.json"],
      project: ["scripts/**/*.ts", "verify/**/*.{mjs,ts}"],
      ignore: [
        "llama.cpp/**",
        "reports/**",
        "verify/bench_results/**",
        "verify/reports/**",
      ],
      ignoreBinaries: ["make"],
    },
    "plugins/plugin-personal-assistant": {
      entry: [
        "src/**/*.{ts,tsx}",
        "scripts/**/*.ts",
        "test/**/*.{ts,tsx}",
        "vitest*.config.ts",
      ],
      project: [
        "src/**/*.{ts,tsx}",
        "scripts/**/*.ts",
        "test/**/*.{ts,tsx}",
        "vitest*.config.ts",
      ],
      ignoreBinaries: [
        "tsc",
        "packages/scripts/plugins/plugin-personal-assistant/work-thread-benchmark.ts",
      ],
    },
    "plugins/plugin-health": {
      entry: [
        "src/index.ts",
        "src/**/*.test.ts",
        "test/**/*.test.ts",
        "vitest.config.ts",
      ],
      project: ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"],
      ignore: [
        "dist/**",
        "src/contracts/lifeops.ts",
        "src/contracts/lifeops-connector-degradation.ts",
        "src/contracts/permissions.ts",
      ],
      ignoreBinaries: ["tsc", "tsup", "vitest", "bunx"],
    },
  },
} satisfies KnipConfig;
const appRoot = fileURLToPath(new URL("./packages/app/", import.meta.url));
const manifest = JSON.parse(
  readFileSync(path.join(appRoot, "package.json"), "utf8"),
) as {
  scripts: Record<string, string>;
  exports: Record<
    string,
    string | { "eliza-source"?: string; import?: string }
  >;
};
const app = config.workspaces["packages/app"];
// Our Node/TS launchers take script paths as arguments. Discover those paths
// even when Knip cannot infer the custom launcher's argument convention.
for (const command of Object.values(manifest.scripts)) {
  for (const [target] of command.matchAll(
    /(?:scripts|native-host)\/[\w./-]+\.[cm]?[jt]sx?\b/g,
  )) {
    if (existsSync(path.join(appRoot, target))) app.entry.push(target);
  }
}
for (const entry of Object.values(manifest.exports)) {
  const target =
    typeof entry === "string"
      ? entry
      : (entry["eliza-source"] ??
        entry.import?.replace("./dist/", "./src/").replace(/\.js$/, ".ts"));
  if (
    target &&
    /\.[cm]?[jt]sx?$/.test(target) &&
    (target.includes("*") || existsSync(path.join(appRoot, target)))
  )
    app.entry.push(target);
}
for (const asset of PUBLISH_ASSET_PATHS) {
  const file = path.join(appRoot, asset);
  if (!existsSync(file)) continue;
  if (statSync(file).isDirectory())
    app.entry.push(`${asset}/**/*.{ts,tsx,mjs}`);
  else if (/\.[cm]?[jt]sx?$/.test(asset)) app.entry.push(asset);
}
export default config;
