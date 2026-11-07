package android.speech;

import android.content.Context;
import android.content.Intent;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Test double: a scripted recognition service. A support check answers the {@link #installed}
 * languages, or {@link #supportError}, or, while {@link #supportSilent}, keeps its callback in
 * {@link #pending} for the test to answer late. {@link #listening} is the last recognizer that
 * started listening, with its listener and intent, for the test to answer. Error codes are the
 * Android 36 values.
 */
public class SpeechRecognizer {
    public static final String RESULTS_RECOGNITION = "results_recognition";
    public static final int ERROR_SPEECH_TIMEOUT = 6;
    public static final int ERROR_NO_MATCH = 7;
    public static final int ERROR_SERVER_DISCONNECTED = 11;
    public static final int ERROR_LANGUAGE_NOT_SUPPORTED = 12;
    public static final int ERROR_LANGUAGE_UNAVAILABLE = 13;

    public static volatile List<String> installed = List.of("en-US");
    public static volatile Integer supportError;
    public static volatile boolean supportSilent;
    public static volatile boolean createThrows;
    public static volatile RecognitionSupportCallback pending;
    public static final AtomicInteger probes = new AtomicInteger();
    public static final AtomicInteger created = new AtomicInteger();
    public static volatile SpeechRecognizer listening;

    public volatile RecognitionListener listener;
    public volatile Intent intent;
    public volatile boolean cancelled;
    public volatile boolean destroyed;

    public static boolean isOnDeviceRecognitionAvailable(Context context) {
        return true;
    }

    public static SpeechRecognizer createOnDeviceSpeechRecognizer(Context context) {
        if (createThrows) throw new SecurityException("recognition service not bound");
        created.incrementAndGet();
        return new SpeechRecognizer();
    }

    public void checkRecognitionSupport(Intent intent, Executor executor, RecognitionSupportCallback callback) {
        probes.incrementAndGet();
        if (supportSilent) {
            pending = callback;
        } else if (supportError != null) {
            int error = supportError;
            executor.execute(() -> callback.onError(error));
        } else {
            List<String> languages = installed;
            executor.execute(() -> callback.onSupportResult(new RecognitionSupport(languages)));
        }
    }

    public void setRecognitionListener(RecognitionListener listener) {
        this.listener = listener;
    }

    public void startListening(Intent intent) {
        this.intent = intent;
        listening = this;
    }

    public void cancel() {
        cancelled = true;
    }

    public void destroy() {
        destroyed = true;
    }
}
