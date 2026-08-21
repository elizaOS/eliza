/**
 * Verifies the generated Android cloud activity preserves native guards that
 * are required after local-runtime sources are stripped from the build.
 */
import { describe, expect, it } from "vitest";
import {
  cloudSafeMainActivityJava,
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

  it("does not register push or background messaging in the minimal Play activity", () => {
    const source = cloudSafeMainActivityJava("ai.elizaos.app");

    expect(source).not.toContain("SafePushNotificationsPlugin");
    expect(source).not.toContain("PushNotifications");
    expect(source).not.toContain("GatewayConnectionService");
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
    expect(source).toContain("registerPlugin(ElizaPlayVoicePlugin.class);");
    expect(coldCapture).toBeGreaterThanOrEqual(0);
    expect(coldCapture).toBeLessThan(bridgeCreation);
    expect(warmCapture).toBeGreaterThanOrEqual(0);
    expect(warmCapture).toBeLessThan(warmDispatch);
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
    expect(source).not.toContain("uses-permission");
    expect(source).not.toContain("http://");
    expect(source).not.toContain("https://");
  });

  it("generates standard speech recognition and system TTS without local transports", () => {
    const source = cloudSafePlayVoicePluginJava("ai.elizaos.app");

    expect(source).toContain('@CapacitorPlugin(\n    name = "ElizaPlayVoice"');
    expect(source).toContain("SpeechRecognizer.createSpeechRecognizer");
    expect(source).toContain("new TextToSpeech(getContext()");
    expect(source).toContain("Manifest.permission.RECORD_AUDIO");
    expect(source).toContain("SpeechRecognizer current = recognizer;");
    expect(source).toContain("recognizer = null;");
    expect(source.indexOf("current.stopListening();")).toBeLessThan(
      source.indexOf("current.cancel();"),
    );
    expect(source.indexOf("current.cancel();")).toBeLessThan(
      source.indexOf("current.destroy();"),
    );
    expect(source).toContain("else failure.addSuppressed(error);");
    expect(source).toContain("if (failure != null) throw failure;");
    expect(source).toContain('"SPEECH_RECOGNITION_STOP_FAILED"');
    expect(source).not.toMatch(/LocalSocket|HttpURLConnection|apiKey|bionic/i);
    expect(source).not.toContain("http://");
    expect(source).not.toContain("https://");
  });
});
