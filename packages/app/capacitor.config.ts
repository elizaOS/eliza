import type { CapacitorConfig } from "@capacitor/cli";
import appConfig from "./app.config";

function isIosStoreBuild(): boolean {
  return (
    process.env.ELIZA_CAPACITOR_BUILD_TARGET === "ios" &&
    (process.env.ELIZA_BUILD_VARIANT === "store" ||
      process.env.ELIZA_RELEASE_AUTHORITY === "apple-app-store")
  );
}

function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

function isPrivateOrLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("10.") ||
    normalized.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(normalized) ||
    normalized.startsWith("169.254.") ||
    (normalized.includes(":") &&
      (normalized.startsWith("fe80:") ||
        normalized.startsWith("fc") ||
        normalized.startsWith("fd"))) ||
    normalized === "local" ||
    normalized === "internal" ||
    normalized === "lan" ||
    normalized === "ts.net" ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".ts.net")
  );
}

function storeSafeAgentApiBase(
  value: string | undefined,
  runtimeMode: string | undefined,
): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || !isIosStoreBuild()) return trimmed;
  if (
    runtimeMode?.trim() === "local" &&
    trimmed === "eliza-local-agent://ipc"
  ) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return "";
    return isPrivateOrLoopbackHost(parsed.hostname) ? "" : trimmed;
  } catch {
    return "";
  }
}

const localNavigationHosts = isIosStoreBuild()
  ? []
  : ["localhost", "127.0.0.1"];
const iosRuntimeMode =
  process.env.VITE_ELIZA_IOS_RUNTIME_MODE ??
  process.env.VITE_ELIZA_MOBILE_RUNTIME_MODE ??
  "";
const iosApiBase = storeSafeAgentApiBase(
  process.env.VITE_ELIZA_IOS_API_BASE ?? process.env.VITE_ELIZA_MOBILE_API_BASE,
  iosRuntimeMode,
);

// E2E/test builds opt into WebView remote debugging via ELIZA_WEBVIEW_DEBUG=1
// (alias MILADY_WEBVIEW_DEBUG). This keeps the bundled APK assets and the real
// on-device agent, but makes the System WebView CDP-attachable so Playwright's
// Android driver (and chrome://inspect) can drive it for end-to-end tests. It
// is NEVER enabled for store builds. Production builds leave it unset → off.
function isFlagEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}
const webViewDebuggingEnabled =
  !isIosStoreBuild() &&
  (isFlagEnabled(process.env.ELIZA_WEBVIEW_DEBUG) ||
    isFlagEnabled(process.env.MILADY_WEBVIEW_DEBUG));

const config: CapacitorConfig = {
  appId: appConfig.appId,
  appName: appConfig.appName,
  webDir: "dist",
  server: {
    androidScheme: "https",
    iosScheme: "https",
    // Allow the webview to connect to the embedded API server and game servers
    allowNavigation: [
      ...localNavigationHosts,
      "*.elizacloud.ai",
      "eliza.app",
      "*.eliza.app",
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
      runtimeMode: iosRuntimeMode,
      fullBunAvailable:
        process.env.VITE_ELIZA_IOS_FULL_BUN_AVAILABLE ??
        process.env.VITE_ELIZA_IOS_FULL_BUN_STRICT ??
        process.env.ELIZA_IOS_FULL_BUN_ENGINE ??
        process.env.ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK ??
        "",
      apiBase: iosApiBase,
    },
    // Native launch screen color. The app's real startup UI is rendered by React.
    SplashScreen: {
      launchShowDuration: 0,
      backgroundColor: "#FF5800",
      androidScaleType: "CENTER_CROP",
      splashFullScreen: true,
      splashImmersive: true,
    },
  },
  ios: {
    contentInset: "automatic",
    preferredContentMode: "mobile",
    backgroundColor: "#FF5800",
    allowsLinkPreview: false,
    webContentsDebuggingEnabled: webViewDebuggingEnabled,
  },
  android: {
    // Point `cap sync` at the SAME android project gradle actually builds
    // (packages/app-core/platforms/android, resolved relative to this config).
    // Without this, cap sync writes a full project to packages/app/android while
    // gradle builds app-core/platforms/android off a STALE committed
    // capacitor.settings.gradle — so native plugins (@capacitor/browser, haptics,
    // …) silently never compile and get pruned from the manifest (#8387). With
    // the path unified, cap sync regenerates the full plugin set in place every
    // build and nothing drifts.
    path: "../app-core/platforms/android",
    backgroundColor: "#FF5800",
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: webViewDebuggingEnabled,
  },
};

export default config;
