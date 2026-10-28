package ai.eliza.voice;

import android.content.Context;
import android.content.Intent;
import android.media.AudioFormat;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.speech.RecognitionListener;
import android.speech.RecognitionSupport;
import android.speech.RecognitionSupportCallback;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Android's on-device English recognizer on a finished recording. It uses
 * {@code createOnDeviceSpeechRecognizer} with the recording fed through
 * {@code EXTRA_AUDIO_SOURCE} (Android 13 and later) and
 * {@code EXTRA_PREFER_OFFLINE}. Nothing goes to a server. Use it only when
 * {@link #available} is true. Any error other than "no speech heard" throws
 * {@link RecognizerUnavailable}; then use {@link NativeAsr}.
 *
 * <p>The app must hold {@code RECORD_AUDIO}. One instance transcribes one
 * recording. Call {@link #transcribe} on a worker thread, never on the main
 * thread. {@link #cancel} may be called from any thread.
 */
public final class OnDeviceRecognizer {
    /** The language used when a host names none. */
    public static final String DEFAULT_LANGUAGE = "en-US";
    private static final int WRITE_BLOCK = 6400;
    private static final java.util.regex.Pattern LANGUAGE_TAG =
            java.util.regex.Pattern.compile("[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*");

    /** Learned once per process and language; absent until asked. */
    private static final java.util.concurrent.ConcurrentHashMap<String, Boolean> usable =
            new java.util.concurrent.ConcurrentHashMap<>();

    private final Context context;
    private final String language;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final CountDownLatch done = new CountDownLatch(1);
    private volatile SpeechRecognizer recognizer;
    private volatile String text;
    private volatile String failure;
    private volatile boolean stopped;

    public OnDeviceRecognizer(Context context) {
        this(context, DEFAULT_LANGUAGE);
    }

    /** A recognizer for one BCP 47 language tag, such as {@code es-US}. */
    public OnDeviceRecognizer(Context context, String languageTag) {
        this.context = context.getApplicationContext();
        this.language = requireLanguage(languageTag);
    }

    /** The tag unchanged when it is a plain BCP 47 language tag; otherwise throws. */
    public static String requireLanguage(String languageTag) {
        if (languageTag == null || !LANGUAGE_TAG.matcher(languageTag).matches())
            throw new IllegalArgumentException("Invalid recognition language");
        return languageTag;
    }

    /** {@link #available(Context, String)} for {@link #DEFAULT_LANGUAGE}. */
    public static boolean available(Context context) {
        return available(context, DEFAULT_LANGUAGE);
    }

    /**
     * True when Android 13 or later has an on-device recognition service with
     * an installed model for the language's primary subtag
     * ({@code checkRecognitionSupport}). The answer is kept for the process
     * per language. Not on the main thread.
     */
    public static boolean available(Context context, String languageTag) {
        String language = requireLanguage(languageTag);
        if (demotedAll) return false;
        Boolean known = usable.get(language);
        if (known != null) return known;
        boolean result = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
                && languageInstalled(context.getApplicationContext(), language);
        usable.putIfAbsent(language, result);
        return usable.get(language);
    }

    /** Turns the recognizer off for every language for the rest of the process. */
    public static void demote() {
        demotedAll = true;
    }

    /** Turns the recognizer off for one language for the rest of the process. */
    public static void demote(String languageTag) {
        usable.put(requireLanguage(languageTag), false);
    }

    private static volatile boolean demotedAll;

    private static boolean languageInstalled(Context context, String language) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false;
        CountDownLatch answered = new CountDownLatch(1);
        boolean[] installed = {false};
        SpeechRecognizer[] probe = {null};
        Handler main = new Handler(Looper.getMainLooper());
        main.post(() -> {
            try {
                probe[0] = SpeechRecognizer.createOnDeviceSpeechRecognizer(context);
                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                        .putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
                String primary = language.split("-", 2)[0];
                probe[0].checkRecognitionSupport(intent, Runnable::run, new RecognitionSupportCallback() {
                    @Override
                    public void onSupportResult(RecognitionSupport support) {
                        for (String tag : support.getInstalledOnDeviceLanguages()) {
                            String installedPrimary = tag.toLowerCase(Locale.ROOT).split("[-_]", 2)[0];
                            if (installedPrimary.equals(primary)) installed[0] = true;
                        }
                        answered.countDown();
                    }

                    @Override
                    public void onError(int error) {
                        answered.countDown();
                    }
                });
            } catch (RuntimeException error) {
                answered.countDown();
            }
        });
        try {
            answered.await(5, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
        main.post(() -> {
            if (probe[0] != null) probe[0].destroy();
        });
        return installed[0];
    }

    /**
     * Transcribes 16 kHz mono 16-bit little-endian PCM. Returns the best
     * hypothesis, or "" when no speech was heard. Throws
     * {@link RecognizerUnavailable} with {@link RecognizerUnavailable#TIMEOUT}
     * when there is no answer within {@code limitMillis}.
     */
    public String transcribe(byte[] pcm16kMono, long limitMillis) throws RecognizerUnavailable {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) throw new RecognizerUnavailable("needs Android 13");
        ParcelFileDescriptor[] pipe;
        try {
            pipe = ParcelFileDescriptor.createPipe();
        } catch (IOException error) {
            throw new RecognizerUnavailable("no pipe");
        }
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
                .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe[0])
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, NativeAsr.SAMPLE_RATE);
        main.post(() -> {
            try {
                if (stopped) {
                    finish(null, "stopped");
                    return;
                }
                recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context);
                recognizer.setRecognitionListener(listener);
                recognizer.startListening(intent);
            } catch (RuntimeException error) {
                finish(null, error.getClass().getSimpleName());
            }
        });
        // The recognizer reads the pipe at its own pace. A separate writer
        // keeps a recognizer that stops reading from holding this call past
        // the limit.
        Thread writer = new Thread(() -> {
            try (OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
                for (int offset = 0; offset < pcm16kMono.length && !stopped && done.getCount() > 0; offset += WRITE_BLOCK) {
                    out.write(pcm16kMono, offset, Math.min(WRITE_BLOCK, pcm16kMono.length - offset));
                }
            } catch (IOException closed) {
                // The recognizer stopped reading; its result or error follows.
            }
        }, "paradee-recognizer-audio");
        writer.setDaemon(true);
        writer.start();
        try {
            if (!done.await(limitMillis, TimeUnit.MILLISECONDS)) failure = RecognizerUnavailable.TIMEOUT;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            failure = "interrupted";
        }
        // Destroying the recognizer closes its copy of the pipe. Closing ours
        // after it ends a write that still waits.
        main.post(() -> {
            SpeechRecognizer open = recognizer;
            recognizer = null;
            if (open != null) open.destroy();
            try {
                pipe[0].close();
            } catch (IOException ignored) {
                // Already closed.
            }
        });
        if (stopped) throw new CancellationException();
        if (failure != null) throw new RecognizerUnavailable(failure);
        return text == null ? "" : text;
    }

    /** Stops the running {@link #transcribe}; it throws {@link CancellationException}. */
    public void cancel() {
        stopped = true;
        main.post(() -> {
            SpeechRecognizer open = recognizer;
            if (open != null) open.cancel();
            finish(null, "stopped");
        });
    }

    private void finish(String heard, String error) {
        if (done.getCount() == 0) return;
        text = heard;
        failure = error;
        done.countDown();
    }

    private final RecognitionListener listener = new RecognitionListener() {
        @Override
        public void onResults(Bundle results) {
            ArrayList<String> hypotheses = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            finish(hypotheses == null || hypotheses.isEmpty() ? "" : hypotheses.get(0), null);
        }

        @Override
        public void onError(int error) {
            // No speech heard is an answer: an empty transcript.
            if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                finish("", null);
                return;
            }
            if (error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE
                    || error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED) {
                demote(language);
            }
            finish(null, "error " + error);
        }

        @Override
        public void onReadyForSpeech(Bundle params) {}

        @Override
        public void onBeginningOfSpeech() {}

        @Override
        public void onRmsChanged(float rmsdB) {}

        @Override
        public void onBufferReceived(byte[] buffer) {}

        @Override
        public void onEndOfSpeech() {}

        @Override
        public void onPartialResults(Bundle partialResults) {}

        @Override
        public void onEvent(int eventType, Bundle params) {}
    };
}
