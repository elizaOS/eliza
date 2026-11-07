package ai.eliza.voice;

import android.content.Context;
import android.content.Intent;
import android.media.AudioFormat;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
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
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Android's on-device recognizer on speech as it is spoken ({@link #feed}, then
 * {@link #finish}) or on a finished recording ({@link #transcribe}). It uses
 * {@code createOnDeviceSpeechRecognizer} with the audio fed through
 * {@code EXTRA_AUDIO_SOURCE} (Android 13 and later) and
 * {@code EXTRA_PREFER_OFFLINE}. Nothing goes to a server. Use it only when
 * {@link #available} is true. Any error other than "no speech heard" throws
 * {@link RecognizerUnavailable}; then use {@link NativeAsr}.
 *
 * <p>The app must hold {@code RECORD_AUDIO}. One instance transcribes one
 * utterance; every session that starts ends with {@link #finish} (or
 * {@link #transcribe}) or {@link #cancel}, which free the recognizer. Call
 * {@link #feed} from the capture thread and {@link #finish} and
 * {@link #transcribe} on a worker thread, never on the main thread.
 * {@link #cancel} may be called from any thread.
 *
 * <p>Android's recognizer can end on its own while speech is still being fed:
 * at a pause, or with "no speech heard" before she starts talking. Then
 * {@link #feed} returns false and {@link #answered} is true; the rest of the
 * speech is not heard, so a host that still records starts a new session (or
 * uses {@link NativeAsr}) for the audio after that point.
 */
public final class OnDeviceRecognizer {
    /** The language used when a host names none. */
    public static final String DEFAULT_LANGUAGE = "en-US";
    private static final int WRITE_BLOCK = 6400;
    /**
     * Most audio {@link #feed} keeps waiting for the recognizer: 64 seconds at
     * 16 kHz mono 16-bit. More means the recognizer stopped reading; the session
     * then ends with {@link #BACKLOG}.
     */
    static final long MAX_BACKLOG_BYTES = 64L * NativeAsr.SAMPLE_RATE * 2;
    /** Reason for a session whose recognizer stopped reading the fed audio. */
    public static final String BACKLOG = "audio backlog";
    private static final java.util.regex.Pattern LANGUAGE_TAG =
            java.util.regex.Pattern.compile("[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*");

    /** How long a "no model for this language" answer is kept, so a model installed later is seen. */
    static final long ABSENT_FOR_MILLIS = 60_000;
    /** How long a probe the recognition service did not answer reads as unavailable before the next one. */
    static final long RETRY_AFTER_MILLIS = 30_000;
    /** What the recognition service answered, per language: see {@link RecognizerAvailability}. */
    private static final RecognizerAvailability availability =
            new RecognizerAvailability(SystemClock::elapsedRealtime, ABSENT_FOR_MILLIS, RETRY_AFTER_MILLIS);

    private final Context context;
    private final String language;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final CountDownLatch done = new CountDownLatch(1);
    /** Ends the recognizer's audio; compared by identity. */
    private static final byte[] END = new byte[0];
    private final LinkedBlockingQueue<byte[]> audio = new LinkedBlockingQueue<>();
    /** Bytes fed and not yet written to the recognizer. */
    private final AtomicLong backlog = new AtomicLong();
    /** Guards {@link #pipe}, {@link #finished} and {@link #released}. */
    private final Object session = new Object();
    private ParcelFileDescriptor[] pipe;
    private boolean finished;
    private boolean released;
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
     * ({@code checkRecognitionSupport}). An installed model is kept for the
     * process; "not installed" is asked again after {@link #ABSENT_FOR_MILLIS}.
     * A probe the service does not answer within 5 seconds reads as false and is
     * asked again after {@link #RETRY_AFTER_MILLIS}; an error that says the
     * language is not supported counts as "not installed". Not on the main
     * thread. A call that asks the service again (the first one, and one after
     * either window ends) can block for up to 5 seconds, so keep it off
     * latency-sensitive paths.
     */
    public static boolean available(Context context, String languageTag) {
        String language = requireLanguage(languageTag);
        return availability.available(language, ticket -> Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
                ? languageInstalled(context.getApplicationContext(), language, ticket)
                : RecognizerAvailability.Answer.ABSENT);
    }

    /** Turns the recognizer off for every language for the rest of the process. */
    public static void demote() {
        availability.demoteAll();
    }

    /** Turns the recognizer off for one language for the rest of the process. */
    public static void demote(String languageTag) {
        availability.demote(requireLanguage(languageTag));
    }

    /** Turns the recognizer off for one language for {@code forMillis}; then it is asked again. */
    public static void demote(String languageTag, long forMillis) {
        availability.demote(requireLanguage(languageTag), forMillis);
    }

    /** Asks the recognition service once; an answer after the 5 second wait is recorded when it comes. */
    private static RecognizerAvailability.Answer languageInstalled(Context context, String language, long ticket) {
        // Repeats the caller's check so the API 31 and 33 calls below are guarded in this method.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return RecognizerAvailability.Answer.ABSENT;
        CountDownLatch answered = new CountDownLatch(1);
        AtomicReference<RecognizerAvailability.Answer> answer =
                new AtomicReference<>(RecognizerAvailability.Answer.UNANSWERED);
        AtomicBoolean gaveUp = new AtomicBoolean();
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
                        boolean installed = false;
                        for (String tag : support.getInstalledOnDeviceLanguages()) {
                            String installedPrimary = tag.toLowerCase(Locale.ROOT).split("[-_]", 2)[0];
                            if (installedPrimary.equals(primary)) installed = true;
                        }
                        RecognizerAvailability.Answer heard = installed
                                ? RecognizerAvailability.Answer.INSTALLED : RecognizerAvailability.Answer.ABSENT;
                        answer.set(heard);
                        if (gaveUp.get()) availability.record(language, heard, ticket);
                        answered.countDown();
                    }

                    @Override
                    public void onError(int error) {
                        // "Not supported" is a no-model answer; any other error is not an
                        // answer, and the language is asked again after the retry window.
                        if (error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED
                                || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE) {
                            answer.set(RecognizerAvailability.Answer.ABSENT);
                            if (gaveUp.get()) {
                                availability.record(language, RecognizerAvailability.Answer.ABSENT, ticket);
                            }
                        }
                        answered.countDown();
                    }
                });
            } catch (RuntimeException error) {
                answered.countDown();
            }
        });
        try {
            if (!answered.await(5, TimeUnit.SECONDS)) gaveUp.set(true);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            gaveUp.set(true);
        }
        main.post(() -> {
            if (probe[0] != null) probe[0].destroy();
        });
        // Read after gaveUp is set: an answer that comes now is returned here or recorded late.
        return answer.get();
    }

    /**
     * Gives the recognizer the next part of the speech: 16 kHz mono 16-bit
     * little-endian PCM. The first call starts the recognizer, so it hears the
     * speech while it is spoken; a separate writer gives it the audio at its own
     * pace, and this call does not wait for it. The array is copied. Then call
     * {@link #finish} or {@link #cancel}. After {@link #cancel} the audio is
     * dropped. Throws {@link RecognizerUnavailable} when the recognizer cannot
     * start; a later failure is reported by {@link #finish}.
     *
     * <p>Returns false when this part was dropped: the session was cancelled, or
     * the recognizer has already answered ({@link #answered}) and reads no more
     * audio. It also returns false, and ends the session with {@link #BACKLOG},
     * when more than {@link #MAX_BACKLOG_BYTES} wait for a recognizer that
     * stopped reading. A part fed just before the recognizer answers can still go
     * unheard, so check {@link #answered} before {@link #finish} too.
     */
    public boolean feed(byte[] pcm16kMono) throws RecognizerUnavailable {
        return feed(pcm16kMono, true);
    }

    /**
     * True once the session has its answer and reads no more audio: the
     * recognizer answered (possibly before {@link #finish}, at a pause or with
     * "no speech heard"), failed, or was cancelled. True before {@link #finish}
     * means {@link #finish} returns that early answer and later speech was not
     * heard.
     */
    public boolean answered() {
        return done.getCount() == 0;
    }

    /**
     * Ends the speech that {@link #feed} gave and waits for the transcript. Returns
     * the best hypothesis, or "" when no speech was heard. Throws
     * {@link RecognizerUnavailable} with {@link RecognizerUnavailable#TIMEOUT}
     * when there is no answer within {@code limitMillis} of this call, and
     * {@link CancellationException} after {@link #cancel}. If the recognizer
     * answers before this call (it heard the end of the speech), this returns that
     * answer. Call it once, on a worker thread.
     */
    public String finish(long limitMillis) throws RecognizerUnavailable {
        synchronized (session) {
            if (finished) throw new IllegalStateException("Recognition already finished");
            finished = true;
            if (!stopped) {
                start();
                audio.add(END);
            }
        }
        try {
            if (!stopped && !done.await(limitMillis, TimeUnit.MILLISECONDS)) answer(null, RecognizerUnavailable.TIMEOUT);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            answer(null, "interrupted");
        } finally {
            release();
        }
        if (stopped) throw new CancellationException();
        if (failure != null) throw new RecognizerUnavailable(failure);
        return text == null ? "" : text;
    }

    /**
     * Transcribes a finished recording of 16 kHz mono 16-bit little-endian PCM:
     * {@link #feed} then {@link #finish}, without a copy of the recording.
     */
    public String transcribe(byte[] pcm16kMono, long limitMillis) throws RecognizerUnavailable {
        feed(pcm16kMono, false);
        return finish(limitMillis);
    }

    /** Stops the session; a running or later {@link #finish} throws {@link CancellationException}. */
    public void cancel() {
        stopped = true;
        main.post(() -> {
            SpeechRecognizer open = recognizer;
            if (open != null) open.cancel();
            answer(null, "stopped");
        });
        release();
    }

    private boolean feed(byte[] pcm16kMono, boolean copy) throws RecognizerUnavailable {
        if (pcm16kMono == null) throw new IllegalArgumentException("Expected PCM");
        synchronized (session) {
            if (finished) throw new IllegalStateException("Recognition already finished");
            if (stopped) return false;
            start();
            // A recognizer that has answered reads no more audio.
            if (done.getCount() == 0) return false;
            if (pcm16kMono.length == 0) return true;
            // A finished recording (transcribe) is one array already in memory;
            // only live parts that pile up behind a stalled recognizer are capped.
            if (!copy || backlog.get() + pcm16kMono.length <= MAX_BACKLOG_BYTES) {
                backlog.addAndGet(pcm16kMono.length);
                audio.add(copy ? pcm16kMono.clone() : pcm16kMono);
                return true;
            }
        }
        // Outside the session lock: answer frees the session, which takes it.
        answer(null, BACKLOG);
        return false;
    }

    /** Caller holds {@link #session}. Starts the recognizer and its audio writer once. */
    private void start() throws RecognizerUnavailable {
        if (pipe != null) return;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) throw new RecognizerUnavailable("needs Android 13");
        ParcelFileDescriptor[] opened;
        try {
            opened = ParcelFileDescriptor.createPipe();
        } catch (IOException error) {
            throw new RecognizerUnavailable("no pipe");
        }
        pipe = opened;
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
                .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, opened[0])
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, NativeAsr.SAMPLE_RATE);
        main.post(() -> {
            try {
                if (stopped) {
                    answer(null, "stopped");
                    return;
                }
                recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context);
                recognizer.setRecognitionListener(listener);
                recognizer.startListening(intent);
            } catch (RuntimeException error) {
                answer(null, error.getClass().getSimpleName());
            }
        });
        // The recognizer reads the pipe at its own pace. A separate writer keeps
        // a recognizer that stops reading from holding feed or finish past the
        // limit. Closing the write end at END tells it the speech has ended.
        Thread writer = new Thread(() -> {
            try (OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(opened[1])) {
                for (byte[] block = audio.take(); block != END && !stopped && done.getCount() > 0; block = audio.take()) {
                    for (int offset = 0; offset < block.length && !stopped && done.getCount() > 0; offset += WRITE_BLOCK) {
                        int length = Math.min(WRITE_BLOCK, block.length - offset);
                        out.write(block, offset, length);
                        backlog.addAndGet(-length);
                    }
                }
            } catch (IOException closed) {
                // The recognizer stopped reading; its result or error follows.
            } catch (InterruptedException interrupted) {
                // Not interrupted by this class; the stream is closed and the result follows.
            }
        }, "paradee-recognizer-audio");
        writer.setDaemon(true);
        writer.start();
    }

    /**
     * Ends the session once: wakes a writer that waits for audio, destroys the
     * recognizer (which closes its copy of the pipe) and then closes ours, which
     * ends a write that still waits.
     */
    private void release() {
        ParcelFileDescriptor[] opened;
        synchronized (session) {
            if (released) return;
            released = true;
            opened = pipe;
        }
        // Audio the recognizer will never read is not kept.
        audio.clear();
        audio.add(END);
        main.post(() -> {
            SpeechRecognizer open = recognizer;
            recognizer = null;
            if (open != null) open.destroy();
            if (opened == null) return;
            try {
                opened[0].close();
            } catch (IOException ignored) {
                // Already closed.
            }
        });
    }

    /**
     * Keeps the first answer: the recognizer's, a timeout, a backlog, an
     * interrupt or a cancel. The session is freed at once, so a recognizer that
     * answers before {@link #finish} holds no service, thread or pipe while the
     * host still records.
     */
    private void answer(String heard, String error) {
        synchronized (this) {
            if (done.getCount() == 0) return;
            text = heard;
            failure = error;
            done.countDown();
        }
        release();
    }

    /** Bytes fed and not yet written to the recognizer; for tests. */
    long backlogBytes() {
        return backlog.get();
    }

    private final RecognitionListener listener = new RecognitionListener() {
        @Override
        public void onResults(Bundle results) {
            ArrayList<String> hypotheses = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            answer(hypotheses == null || hypotheses.isEmpty() ? "" : hypotheses.get(0), null);
        }

        @Override
        public void onError(int error) {
            // No speech heard is an answer: an empty transcript.
            if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                answer("", null);
                return;
            }
            if (error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE
                    || error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED) {
                demote(language);
            }
            answer(null, "error " + error);
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
