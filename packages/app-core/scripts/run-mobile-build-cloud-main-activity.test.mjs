/**
 * Verifies the generated Android cloud activity preserves native guards that
 * are required after local-runtime sources are stripped from the build.
 */
import { describe, expect, it } from "vitest";
import {
  cloudSafeMainActivityJava,
  cloudSafePlayExportPluginJava,
  cloudSafePlaySettingsPluginJava,
  cloudSafePlayVoicePluginJava,
  cloudSafeSecureCredentialsPluginJava,
} from "./run-mobile-build.mjs";

describe("cloudSafeMainActivityJava", () => {
  it("installs the splash lifecycle before Capacitor creates the bridge", () => {
    const source = cloudSafeMainActivityJava("ai.elizaos.app");
    const splashInstall = source.indexOf(
      "SplashScreen.installSplashScreen(this);",
    );
    const bridgeCreation = source.indexOf(
      "super.onCreate(savedInstanceState);",
    );

    expect(source).toContain("import androidx.core.splashscreen.SplashScreen;");
    expect(splashInstall).toBeGreaterThanOrEqual(0);
    expect(splashInstall).toBeLessThan(bridgeCreation);
  });

  it("registers crash-guarded push without any background agent service", () => {
    const source = cloudSafeMainActivityJava("ai.elizaos.app");

    expect(source).toContain(
      "getBridge().registerPlugin(SafePushNotificationsPlugin.class);",
    );
    expect(source).not.toContain("GatewayConnectionService");
  });

  it("uses public edge-to-edge APIs without hiding the system bars", () => {
    const source = cloudSafeMainActivityJava("ai.elizaos.app");

    expect(source).toContain(
      "WindowCompat.setDecorFitsSystemWindows(getWindow(), false);",
    );
    expect(source).toContain("setAppearanceLightStatusBars(false)");
    expect(source).toContain("setAppearanceLightNavigationBars(false)");
    expect(source).not.toContain("controller.hide(");
    expect(source).not.toContain("SYSTEM_UI_FLAG_");
  });

  it("keeps kiosk navigation suppression out of ordinary Cloud builds", () => {
    const source = cloudSafeMainActivityJava("ai.elizaos.app");

    expect(source).not.toContain("OnBackPressedCallback");
    expect(source).not.toContain("startLockTask()");
    expect(source).not.toContain("KEYCODE_FORWARD");
    expect(source).not.toContain("KEYCODE_NAVIGATE_NEXT");
  });

  it("pins the launcher task and suppresses Back and Forward only in kiosk", () => {
    const source = cloudSafeMainActivityJava("ai.elizaos.app", {
      launcherKiosk: true,
    });

    expect(source).toContain("import android.view.KeyEvent;");
    expect(source).toContain("import androidx.activity.OnBackPressedCallback;");
    expect(source).toContain("new OnBackPressedCallback(true)");
    expect(source).toContain("public void handleOnBackPressed()");
    expect(source).toContain("public boolean dispatchKeyEvent(KeyEvent event)");
    expect(source).toContain("KeyEvent.KEYCODE_FORWARD");
    expect(source).toContain("KeyEvent.KEYCODE_NAVIGATE_NEXT");
    expect(source).toContain("startLockTask();");
    expect(source).toContain("protected void onResume()");
    expect(source).toContain("super.onResume();");
    expect(source).toContain(
      "IllegalArgumentException | IllegalStateException | SecurityException",
    );
  });

  it("uses no hidden Android system-property API in the Play activity", () => {
    const source = cloudSafeMainActivityJava("ai.elizaos.app");

    expect(source).not.toContain("android.os.SystemProperties");
    expect(source).not.toContain("java.lang.reflect");
    expect(source).not.toContain("Class.forName(");
    expect(source).not.toContain("readSystemProperty");
  });

  it("captures cold and warm deep links before Capacitor dispatches them", () => {
    const source = cloudSafeMainActivityJava("ai.elizaos.app");
    const coldCapture = source.indexOf(
      "DeepLinkBufferPlugin.captureIntent(this, getIntent());",
    );
    const bridgeCreation = source.indexOf(
      "super.onCreate(savedInstanceState);",
    );
    const warmCapture = source.indexOf(
      "DeepLinkBufferPlugin.captureIntent(this, intent);",
    );
    const warmDispatch = source.indexOf("super.onNewIntent(intent);");

    expect(source).toContain("registerPlugin(DeepLinkBufferPlugin.class);");
    expect(source).toContain(
      "registerPlugin(ElizaSecureCredentialsPlugin.class);",
    );
    expect(source).toContain("registerPlugin(ElizaPlayExportPlugin.class);");
    expect(source).toContain("registerPlugin(ElizaPlayVoicePlugin.class);");
    expect(source).toContain("registerPlugin(ElizaPlaySettingsPlugin.class);");
    expect(source).not.toContain("GoogleIdentityPlugin");
    expect(coldCapture).toBeGreaterThanOrEqual(0);
    expect(coldCapture).toBeLessThan(bridgeCreation);
    expect(warmCapture).toBeGreaterThanOrEqual(0);
    expect(warmCapture).toBeLessThan(warmDispatch);
  });

  it("opens only this package's Android permission settings", () => {
    const source = cloudSafePlaySettingsPluginJava("ai.elizaos.app");

    expect(source).toContain('@CapacitorPlugin(name = "ElizaPlaySettings")');
    expect(source).toContain("Settings.ACTION_APPLICATION_DETAILS_SETTINGS");
    expect(source).toContain("Settings.ACTION_APP_NOTIFICATION_SETTINGS");
    expect(source).toContain("Settings.EXTRA_APP_PACKAGE");
    expect(source).toContain(
      'Uri.parse("package:" + getContext().getPackageName())',
    );
    expect(source).not.toContain("uses-permission");
    expect(source).not.toContain("MANAGE_");
  });

  it("generates permissionless Android Keystore AES-GCM credential storage", () => {
    const source = cloudSafeSecureCredentialsPluginJava("ai.elizaos.app");

    expect(source).toContain(
      '@CapacitorPlugin(name = "ElizaSecureCredentials")',
    );
    expect(source).toContain("KeyStore.getInstance(ANDROID_KEYSTORE)");
    expect(source).toContain("Cipher.getInstance(TRANSFORMATION)");
    expect(source).toContain("KeyProperties.BLOCK_MODE_GCM");
    expect(source).toContain(".setRandomizedEncryptionRequired(true)");
    expect(source).toContain('"pending_login".equals(slot)');
    expect(source).toContain('"mobile_login_ciphertext"');
    expect(
      source.match(/private String preferenceKey\(PluginCall call\)/g),
    ).toHaveLength(1);
    expect(source).not.toContain("CREDENTIAL_CIPHERTEXT");
    expect(source).toContain('"account_deletion_admission".equals(slot)');
    expect(source).toContain('"account_deletion_status".equals(slot)');
    expect(source).toContain('"account_deletion_recovery".equals(slot)');
    expect(source).toContain("putString(preferenceKey, encoded).commit()");
    expect(source).toContain("remove(preferenceKey).commit()");
    expect(source).toContain(
      'private static final String LOCAL_APP_ORIGIN = "https://localhost";',
    );
    expect(source).toContain(
      "LOCAL_APP_ORIGIN.equals(getBridge().getLocalUrl())",
    );
    expect(source).toContain('!"https".equals(current.getScheme())');
    expect(source).toContain('!"localhost".equals(current.getHost())');
    expect(source).toContain("current.getPort() != -1");
    expect(source).toContain(
      "private final Handler mainHandler = new Handler(Looper.getMainLooper());",
    );
    expect(source).toContain(
      "if (Looper.myLooper() == Looper.getMainLooper()) return webView.getUrl();",
    );
    expect(source).toContain("mainHandler.post(() -> {");
    expect(source).toContain(
      "completed.await(WEBVIEW_URL_TIMEOUT_SECONDS, TimeUnit.SECONDS)",
    );
    expect(source).toContain("Thread.currentThread().interrupt();");
    expect(source).not.toContain(
      "String currentUrl = webView == null ? null : webView.getUrl();",
    );
    expect(
      source.match(/if \(!requireExactLocalOrigin\(call\)\) return;/g),
    ).toHaveLength(3);
    expect(source).not.toContain("uses-permission");
    expect(source).not.toContain("http://");
    expect(source.match(/https:\/\//g)).toHaveLength(1);
  });

  it("saves verified exports with the standard document picker", () => {
    const source = cloudSafePlayExportPluginJava("ai.elizaos.app");

    expect(source).toContain('@CapacitorPlugin(name = "ElizaPlayExport")');
    expect(source).toContain("Intent.ACTION_CREATE_DOCUMENT");
    expect(source).toContain('connection.setRequestMethod("POST")');
    expect(source).toContain('"X-Account-Deletion-Recovery"');
    expect(source).toContain("EXPORT MY DATA");
    expect(source).toContain('MessageDigest.getInstance("SHA-256")');
    expect(source).toContain("MessageDigest.isEqual(");
    expect(source).toContain("expectedDigest.toLowerCase(Locale.ROOT)");
    expect(source).toContain("MAX_EXPORT_BYTES = 32 * 1024 * 1024");
    expect(source).toContain("connection.setInstanceFollowRedirects(false)");
    expect(source).not.toContain("uses-permission");
    expect(source).not.toMatch(
      /MANAGE_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE/,
    );
  });

  it("generates standard speech recognition and system TTS without local transports", () => {
    const source = cloudSafePlayVoicePluginJava("ai.elizaos.app");
    const pluginThreadEntry = source.slice(
      source.indexOf("public void startDictation"),
      source.indexOf("private void startDictationOnMainThread"),
    );

    expect(source).toContain('@CapacitorPlugin(\n    name = "ElizaPlayVoice"');
    expect(source).toContain(
      "private final Handler mainHandler = new Handler(Looper.getMainLooper());",
    );
    expect(source).toContain(
      "runOnMainThread(() -> startDictationOnMainThread(call, language));",
    );
    expect(source).toContain(
      "runOnMainThread(this::stopRecognizerOnMainThread);",
    );
    expect(source).toContain(
      "runOnMainThread(() -> speakOnMainThread(call, text, language));",
    );
    expect(pluginThreadEntry).not.toContain(
      "SpeechRecognizer.createSpeechRecognizer",
    );
    expect(pluginThreadEntry).not.toContain("recognizer.startListening");
    expect(source).toContain("SpeechRecognizer.createSpeechRecognizer");
    expect(source).toContain("new TextToSpeech(getContext()");
    expect(source).toContain("Manifest.permission.RECORD_AUDIO");
    expect(source).not.toMatch(/LocalSocket|HttpURLConnection|apiKey|bionic/i);
    expect(source).not.toContain("http://");
    expect(source).not.toContain("https://");
  });
});
