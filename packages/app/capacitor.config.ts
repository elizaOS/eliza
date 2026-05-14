import type { CapacitorConfig } from "@capacitor/cli";
import appConfig from "./app.config";

const capacitorBuildTarget =
  process.env.ELIZA_CAPACITOR_BUILD_TARGET ??
  process.env.CAPACITOR_PLATFORM ??
  (process.argv.includes("android")
    ? "android"
    : process.argv.includes("ios")
      ? "ios"
      : "");

const loopbackNavigationHosts =
  capacitorBuildTarget === "android" ? ["localhost", "127.0.0.1"] : [];

const config: CapacitorConfig = {
  appId: appConfig.appId,
  appName: appConfig.appName,
  webDir: "dist",
  server: {
    androidScheme: "https",
    iosScheme: "https",
    // Android local mode owns a loopback API/device bridge. iOS local mode is
    // IPC-only through the native Bun runtime bridge, so it must not whitelist
    // localhost navigation.
    allowNavigation: [
      ...loopbackNavigationHosts,
      "*.elizacloud.ai",
      "app.eliza.how",
      "cloud.eliza.how",
      "*.eliza.how",
      "rs-sdk-demo.fly.dev",
      "*.fly.dev",
      "hyperscape.gg",
      "*.hyperscape.gg",
    ],
  },
  plugins: {
    Keyboard: {
      resize: "body",
      resizeOnFullScreen: true,
    },
    // Patches `fetch`/`XMLHttpRequest` on native platforms to use the
    // native HTTP stack (CFNetwork on iOS). Required for cross-origin
    // requests like `https://www.elizacloud.ai/api/auth/cli-session` —
    // those fail under WKWebView's CORS check from `capacitor://localhost`.
    CapacitorHttp: {
      enabled: true,
    },
    BackgroundRunner: {
      label: "eliza-tasks",
      src: "runners/eliza-tasks.js",
      event: "wake",
      repeat: true,
      interval: 15,
      autoStart: true,
    },
    Agent: {
      runtimeMode:
        process.env.VITE_ELIZA_IOS_RUNTIME_MODE ??
        process.env.VITE_ELIZA_MOBILE_RUNTIME_MODE ??
        "",
      apiBase:
        process.env.VITE_ELIZA_IOS_API_BASE ??
        process.env.VITE_ELIZA_MOBILE_API_BASE ??
        "",
    },
  },
  ios: {
    contentInset: "automatic",
    preferredContentMode: "mobile",
    backgroundColor: "#0a0a0a",
    allowsLinkPreview: false,
  },
  android: {
    backgroundColor: "#0a0a0a",
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
};

export default config;
