import type { CapacitorConfig } from "@capacitor/cli";
import appConfig from "./app.config";

const config: CapacitorConfig = {
  appId: appConfig.appId,
  appName: appConfig.appName,
  webDir: "dist",
  server: {
    androidScheme: "https",
    iosScheme: "https",
    // Allow the webview to connect to the embedded API server and game servers
    allowNavigation: [
      "localhost",
      "127.0.0.1",
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
