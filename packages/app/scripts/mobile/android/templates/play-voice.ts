/** Renders the Android play voice Java source for cloud-safe mobile builds. */

/** Standard Android SpeechRecognizer + system TextToSpeech for Play builds. */
export function cloudSafePlayVoicePluginJava(androidPackage) {
  return `package ${androidPackage};

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.Locale;
import java.util.UUID;

@CapacitorPlugin(
    name = "ElizaPlayVoice",
    permissions = @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
)
public final class ElizaPlayVoicePlugin extends Plugin implements RecognitionListener {
    private static final long TTS_START_WATCHDOG_MS = 60_000L;
    private static final long TTS_STALL_POLL_MS = 30_000L;
    private static final long TTS_TERMINAL_GRACE_MS = 10_000L;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private SpeechSession activeSpeech;

    private static final class SpeechSession {
        private final PluginCall call;
        private final String utteranceId;
        private TextToSpeech tts;
        private Runnable watchdog;
        private boolean playbackStarted;
        private boolean terminalGraceArmed;

        private SpeechSession(PluginCall call) {
            this.call = call;
            this.utteranceId = UUID.randomUUID().toString();
        }
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            resolvePermission(call, true);
            return;
        }
        requestPermissionForAlias("microphone", call, "microphonePermissionCallback");
    }

    @PermissionCallback
    private void microphonePermissionCallback(PluginCall call) {
        resolvePermission(call, getPermissionState("microphone") == PermissionState.GRANTED);
    }

    @PluginMethod
    public void startDictation(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("Microphone permission is required.", "MICROPHONE_PERMISSION_REQUIRED");
            return;
        }
        String language = call.getString("language");
        runOnMainThread(() -> startDictationOnMainThread(call, language));
    }

    private void startDictationOnMainThread(PluginCall call, String language) {
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            call.reject("Speech recognition is unavailable.", "SPEECH_RECOGNITION_UNAVAILABLE");
            return;
        }
        stopRecognizerOnMainThread();
        try {
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            recognizer.setRecognitionListener(this);
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
            intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
            if (language != null && !language.trim().isEmpty()) {
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language.trim());
            }
            recognizer.startListening(intent);
            JSObject result = new JSObject();
            result.put("started", true);
            call.resolve(result);
        } catch (RuntimeException error) {
            stopRecognizerOnMainThread();
            call.reject("Voice dictation could not start.", "SPEECH_RECOGNITION_START_FAILED", error);
        }
    }

    @PluginMethod
    public void stopDictation(PluginCall call) {
        runOnMainThread(() -> {
            stopRecognizerOnMainThread();
            call.resolve();
        });
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text");
        if (text == null || text.trim().isEmpty()) {
            call.reject("Speech text is required.", "TTS_TEXT_REQUIRED");
            return;
        }
        String language = call.getString("language", Locale.getDefault().toLanguageTag());
        runOnMainThread(() -> speakOnMainThread(call, text, language));
    }

    private void speakOnMainThread(PluginCall call, String text, String language) {
        stopActiveSpeechOnMainThread(
                "Speech playback was replaced by a newer request.",
                "TTS_REPLACED");
        SpeechSession session = new SpeechSession(call);
        activeSpeech = session;
        try {
            session.tts = new TextToSpeech(
                    getContext(),
                    status -> mainHandler.post(
                            () -> initializeSpeechOnMainThread(session, text, language, status)));
        } catch (RuntimeException error) {
            // error-policy:J1 Translate native construction failures to the pending Capacitor call.
            if (activeSpeech == session) activeSpeech = null;
            call.reject("System text to speech is unavailable.", "TTS_UNAVAILABLE", error);
        }
    }

    private void initializeSpeechOnMainThread(
            SpeechSession session,
            String text,
            String language,
            int status) {
        if (activeSpeech != session) return;
        TextToSpeech tts = session.tts;
        if (status != TextToSpeech.SUCCESS || tts == null) {
            rejectActiveSpeechOnMainThread(
                    session,
                    "System text to speech is unavailable.",
                    "TTS_UNAVAILABLE");
            return;
        }
        Locale locale = Locale.forLanguageTag(language == null ? "" : language);
        if (tts.setLanguage(locale) < TextToSpeech.LANG_AVAILABLE) {
            rejectActiveSpeechOnMainThread(
                    session,
                    "The selected speech language is unavailable.",
                    "TTS_LANGUAGE_UNAVAILABLE");
            return;
        }
        int listenerStatus = tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) {
                markPlaybackProgress(session, id);
            }
            @Override public void onRangeStart(String id, int start, int end, int frame) {
                markPlaybackProgress(session, id);
            }
            @Override public void onDone(String id) {
                if (!session.utteranceId.equals(id)) return;
                mainHandler.post(() -> resolveActiveSpeechOnMainThread(session));
            }
            @Override public void onError(String id) {
                rejectPlayback(
                        session,
                        id,
                        "System text to speech failed during playback.",
                        "TTS_PLAYBACK_FAILED");
            }
            @Override public void onError(String id, int errorCode) {
                rejectPlayback(
                        session,
                        id,
                        "System text to speech failed during playback.",
                        "TTS_PLAYBACK_FAILED");
            }
            @Override public void onStop(String id, boolean interrupted) {
                rejectPlayback(
                        session,
                        id,
                        "System text to speech was interrupted.",
                        "TTS_INTERRUPTED");
            }
        });
        if (listenerStatus != TextToSpeech.SUCCESS) {
            rejectActiveSpeechOnMainThread(
                    session,
                    "System text to speech callbacks are unavailable.",
                    "TTS_LISTENER_FAILED");
            return;
        }
        int accepted = tts.speak(
                text,
                TextToSpeech.QUEUE_FLUSH,
                null,
                session.utteranceId);
        if (accepted != TextToSpeech.SUCCESS) {
            rejectActiveSpeechOnMainThread(
                    session,
                    "System text to speech could not start.",
                    "TTS_START_FAILED");
            return;
        }
        armSpeechWatchdogOnMainThread(session, TTS_START_WATCHDOG_MS);
    }

    private void rejectPlayback(
            SpeechSession session,
            String utteranceId,
            String message,
            String code) {
        if (!session.utteranceId.equals(utteranceId)) return;
        mainHandler.post(() -> rejectActiveSpeechOnMainThread(
                session,
                message,
                code));
    }

    private void markPlaybackProgress(
            SpeechSession session,
            String utteranceId) {
        if (!session.utteranceId.equals(utteranceId)) return;
        mainHandler.post(() -> {
            if (activeSpeech != session) return;
            session.playbackStarted = true;
            session.terminalGraceArmed = false;
            armSpeechWatchdogOnMainThread(session, TTS_STALL_POLL_MS);
        });
    }

    private void resolveActiveSpeechOnMainThread(SpeechSession session) {
        if (activeSpeech != session) return;
        cancelSpeechWatchdogOnMainThread(session);
        activeSpeech = null;
        if (session.tts != null) session.tts.shutdown();
        session.call.resolve();
    }

    private void rejectActiveSpeechOnMainThread(
            SpeechSession session,
            String message,
            String code) {
        if (activeSpeech != session) return;
        cancelSpeechWatchdogOnMainThread(session);
        activeSpeech = null;
        if (session.tts != null) {
            session.tts.stop();
            session.tts.shutdown();
        }
        session.call.reject(message, code);
    }

    private void stopActiveSpeechOnMainThread(String message, String code) {
        SpeechSession session = activeSpeech;
        if (session == null) return;
        cancelSpeechWatchdogOnMainThread(session);
        activeSpeech = null;
        if (session.tts != null) {
            session.tts.stop();
            session.tts.shutdown();
        }
        session.call.reject(message, code);
    }

    private void armSpeechWatchdogOnMainThread(
            SpeechSession session,
            long delayMs) {
        if (activeSpeech != session) return;
        cancelSpeechWatchdogOnMainThread(session);
        session.watchdog = () -> checkSpeechWatchdogOnMainThread(session);
        mainHandler.postDelayed(session.watchdog, delayMs);
    }

    private void checkSpeechWatchdogOnMainThread(SpeechSession session) {
        if (activeSpeech != session) return;
        boolean speaking = false;
        try {
            speaking = session.tts != null && session.tts.isSpeaking();
        } catch (RuntimeException ignored) {
            // error-policy:J1 The watchdog translates a disconnected engine to
            // the bounded TTS_TIMEOUT rejection below.
            // A disconnected engine reports as stalled and follows the same
            // bounded terminal-grace path below.
        }
        if (speaking) {
            session.playbackStarted = true;
            session.terminalGraceArmed = false;
            armSpeechWatchdogOnMainThread(session, TTS_STALL_POLL_MS);
            return;
        }
        if (session.playbackStarted && !session.terminalGraceArmed) {
            session.terminalGraceArmed = true;
            armSpeechWatchdogOnMainThread(session, TTS_TERMINAL_GRACE_MS);
            return;
        }
        rejectActiveSpeechOnMainThread(
                session,
                "System text to speech did not report a terminal playback event.",
                "TTS_TIMEOUT");
    }

    private void cancelSpeechWatchdogOnMainThread(SpeechSession session) {
        if (session.watchdog == null) return;
        mainHandler.removeCallbacks(session.watchdog);
        session.watchdog = null;
    }

    @PluginMethod
    public void stop(PluginCall call) {
        runOnMainThread(() -> {
            stopActiveSpeechOnMainThread(
                    "Speech playback was stopped.",
                    "TTS_STOPPED");
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        runOnMainThread(() -> {
            stopRecognizerOnMainThread();
            stopActiveSpeechOnMainThread(
                    "Speech playback stopped because the voice bridge was destroyed.",
                    "TTS_DESTROYED");
        });
        super.handleOnDestroy();
    }

    private void resolvePermission(PluginCall call, boolean granted) {
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    private void runOnMainThread(Runnable action) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            action.run();
        } else {
            mainHandler.post(action);
        }
    }

    private void stopRecognizerOnMainThread() {
        if (recognizer == null) return;
        try { recognizer.stopListening(); } catch (RuntimeException ignored) {}
        recognizer.cancel();
        recognizer.destroy();
        recognizer = null;
    }

    private void publishTranscript(Bundle results, boolean isFinal) {
        ArrayList<String> values = results == null
                ? null
                : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (values == null || values.isEmpty()) return;
        String text = values.get(0) == null ? "" : values.get(0).trim();
        if (text.isEmpty()) return;
        JSObject event = new JSObject();
        event.put("text", text);
        event.put("isFinal", isFinal);
        notifyListeners("transcript", event);
    }

    @Override public void onReadyForSpeech(Bundle params) {}
    @Override public void onBeginningOfSpeech() {}
    @Override public void onRmsChanged(float rmsdB) {}
    @Override public void onBufferReceived(byte[] buffer) {}
    @Override public void onEndOfSpeech() {}
    @Override public void onError(int error) {
        JSObject event = new JSObject();
        event.put("code", error);
        notifyListeners("error", event);
        stopRecognizerOnMainThread();
    }
    @Override public void onResults(Bundle results) {
        publishTranscript(results, true);
        stopRecognizerOnMainThread();
    }
    @Override public void onPartialResults(Bundle partialResults) {
        publishTranscript(partialResults, false);
    }
    @Override public void onEvent(int eventType, Bundle params) {}
}
`;
}
