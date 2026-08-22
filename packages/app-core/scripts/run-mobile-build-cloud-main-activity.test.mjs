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
      "runOnMainThread(() -> speakOnMainThread(call, text, language));",
    );
    expect(pluginThreadEntry).not.toContain(
      "SpeechRecognizer.createSpeechRecognizer",
    );
    expect(pluginThreadEntry).not.toContain("recognizer.startListening");
    expect(source).toContain("SpeechRecognizer.createSpeechRecognizer");
    expect(source).toContain(
      "private final Handler mainHandler = new Handler(Looper.getMainLooper());",
    );
    expect(source).toContain(
      "runOnMainThread(() -> startDictationOnMainThread(call, language));",
    );
    expect(source).toContain("runOnMainThread(() -> {");
    expect(source).toContain(
      "runOnMainThread(() -> speakOnMainThread(call, text, language));",
    );
    expect(source).toContain(
      "if (Looper.myLooper() == Looper.getMainLooper())",
    );
    expect(source).toContain("mainHandler.post(action);");
    expect(source).toContain("new TextToSpeech(getContext()");
    expect(source).toContain("Manifest.permission.RECORD_AUDIO");
    expect(source).toContain("long nextEpoch = ++recognizerEpoch;");
    expect(source).toContain(
      "return activeRecognizer == nextSession && recognizerEpoch == nextEpoch;",
    );
    expect(source).toContain("retryStaleRecognizerCleanup(nextSession);");
    expect(source).toContain(
      "private final ArrayList<RecognizerSession> recognizersPendingCleanup",
    );
    expect(source).toContain(
      "private RuntimeException stopRecognizerInstance(RecognizerSession session)",
    );
    expect(source.indexOf("current.stopListening();")).toBeLessThan(
      source.indexOf("current.cancel();"),
    );
    expect(source.indexOf("current.cancel();")).toBeLessThan(
      source.indexOf("current.destroy();"),
    );
    expect(source).toContain("else failure.addSuppressed(error);");
    expect(source).toContain("if (failure != null) throw failure;");
    expect(source).toContain('"SPEECH_RECOGNITION_STOP_FAILED"');
    expect(source).toContain(
      "private void stopRecognizerAfterCallback(RecognizerSession callbackSession)",
    );
    expect(source).toContain(
      'android.util.Log.e("ElizaPlayVoice", "Recognizer callback cleanup failed", error);',
    );
    expect(source).toContain('event.put("code", -1);');
    expect(source).toContain("session.destroyed = true;");
    expect(source).toContain(
      "if (!recognizersPendingCleanup.contains(staleSession)) return;",
    );
    expect(source).toContain(
      "if (!current.destroyed && !recognizersPendingCleanup.contains(current))",
    );
    const listenerStart = source.indexOf("new RecognitionListener()");
    const callbackError = source.indexOf(
      "@Override public void onError(int error)",
      listenerStart,
    );
    const callbackResults = source.indexOf(
      "@Override public void onResults(Bundle results)",
      callbackError,
    );
    const callbackPartial = source.indexOf(
      "@Override public void onPartialResults(Bundle partialResults)",
      callbackResults,
    );
    const errorBody = source.slice(callbackError, callbackResults);
    const resultsBody = source.slice(callbackResults, callbackPartial);
    expect(errorBody.indexOf("if (!ownsCurrentRecognizer())")).toBeLessThan(
      errorBody.indexOf('notifyListeners("error", event);'),
    );
    expect(resultsBody.indexOf("if (!ownsCurrentRecognizer())")).toBeLessThan(
      resultsBody.indexOf("publishTranscript(results, true);"),
    );
    expect(errorBody).toContain("cleanupAfterCallback();");
    expect(resultsBody).toContain("cleanupAfterCallback();");
    expect(errorBody).toContain("finally {");
    expect(resultsBody).toContain("finally {");
    expect(errorBody).toContain("Recognizer error publication failed");
    expect(resultsBody).toContain("Recognizer result publication failed");
    expect(errorBody).not.toContain("stopRecognizer();");
    expect(resultsBody).not.toContain("stopRecognizer();");
    expect(source).not.toMatch(/LocalSocket|HttpURLConnection|apiKey|bionic/i);
    expect(source).not.toContain("http://");
    expect(source).not.toContain("https://");
  });
});
