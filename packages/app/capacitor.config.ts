/**
 * Builds the Capacitor mobile configuration from the shared app identity and
 * runtime settings.
 */
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

function resolveServerUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || isIosStoreBuild()) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    if (!isPrivateOrLoopbackHost(parsed.hostname)) return undefined;
    return parsed.href.replace(/\/$/, "");
  } catch {
    // error-policy:J3 invalid test-only server URL disables the override
    return undefined;
  }
}

const serverUrl = resolveServerUrl(process.env.ELIZA_CAPACITOR_SERVER_URL);

// E2E/test builds opt into WebView remote debugging via ELIZA_WEBVIEW_DEBUG=1.
// This keeps the bundled APK assets and the real
// on-device agent, but makes the System WebView CDP-attachable so Playwright's
// Android driver (and chrome://inspect) can drive it for end-to-end tests. It
// is NEVER enabled for store builds. Production builds leave it unset → off.
function isFlagEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}
const webViewDebuggingEnabled =
  !isIosStoreBuild() && isFlagEnabled(process.env.ELIZA_WEBVIEW_DEBUG);

export function resolveAndroidProjectPath(
  useAppDir: string | undefined,
  appId: string,
): string {
  return useAppDir === "1" || appId !== "ai.elizaos.app"
    ? "android"
    : "../app-core/platforms/android";
}

const androidProjectPath = resolveAndroidProjectPath(
  process.env.ELIZA_ANDROID_USE_APP_DIR,
  appConfig.appId,
);

const config: CapacitorConfig = {
  appId: appConfig.appId,
  appName: appConfig.appName,
  webDir: "dist",
  server: {
    androidScheme: "https",
    iosScheme: "https",
    ...(serverUrl ? { url: serverUrl } : {}),
    // Allow the webview to connect to the embedded API server
    allowNavigation: [
      ...localNavigationHosts,
      "*.elizacloud.ai",
      "eliza.app",
      "*.eliza.app",
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
    // Native launch screen color. Matches the default home background orange
    // (#ef5a1f) so the native splash flows into the React home with no orange
    // flash (issue #9565). The app's real startup UI is rendered by React.
    SplashScreen: {
      launchShowDuration: 0,
      backgroundColor: "#ef5a1f",
      androidScaleType: "CENTER_CROP",
      splashFullScreen: true,
      splashImmersive: true,
    },
  },
  ios: {
    // "never": the WKWebView extends edge-to-edge under the home indicator
    // instead of being inset (which revealed the native background as an orange
    // band at the bottom safe-area). The web layer owns safe-area insets via
    // viewport-fit=cover + env(safe-area-inset-*); the chat composer adds its
    // own bottom inset so it stays clear of the home indicator.
    contentInset: "never",
    preferredContentMode: "mobile",
    backgroundColor: "#ef5a1f",
    allowsLinkPreview: false,
    webContentsDebuggingEnabled: webViewDebuggingEnabled,
  },
  android: {
    // Keep `cap sync` pointed at the same Android tree run-mobile-build will
    // package. Upstream elizaOS owns the shared app-core tree; white-label or
    // explicitly isolated builds use the app-local ignored android/ project.
    path: androidProjectPath,
    backgroundColor: "#ef5a1f",
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: webViewDebuggingEnabled,
  },
};

export default config;
