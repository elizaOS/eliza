package ai.eliza.speech;

import android.content.Context;
import android.content.Intent;
import android.media.AudioFormat;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * MIT. One entry point for local English transcription of 16 kHz mono PCM.
 * It uses the Android on-device recognizer when the device has one that
 * accepts supplied audio (Android 13+, language pack installed). Otherwise it
 * uses this module's Whisper tiny.en engine. No path sends audio off the
 * device. Call {@link #transcribe} on a worker thread, never the main thread.
 */
public final class LocalTranscriber {
    public enum Backend { ANDROID_ON_DEVICE, WHISPER_TINY_EN }

    public static final class Result {
        public final String text;
        public final Backend backend;

        Result(String text, Backend backend) {
            this.text = text;
            this.backend = backend;
        }
    }

    /** The on-device recognizer exists but cannot serve English now. */
    private static final class Unavailable extends Exception {
        Unavailable(String message) {
            super(message);
        }
    }

    private final Context context;
    private final LocalSpeechEngineHolder whisper;

    public LocalTranscriber(Context context, LocalSpeechEngineHolder whisper) {
        this.context = context.getApplicationContext();
        this.whisper = whisper;
    }

    /** True when Android offers an on-device recognizer that reads supplied audio. */
    public static boolean onDeviceAvailable(Context context) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && SpeechRecognizer.isOnDeviceRecognitionAvailable(context);
    }

    public Result transcribe(float[] mono16k) throws Exception {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            throw new IllegalStateException("Transcribe on a worker thread");
        }
        if (onDeviceAvailable(context)) {
            try {
                return new Result(recognizeOnDevice(mono16k), Backend.ANDROID_ON_DEVICE);
            } catch (Unavailable reason) {
                // The language pack is missing or the service declined English.
                android.util.Log.i("LocalTranscriber", "On-device recognizer unavailable: " + reason.getMessage());
            }
        }
        return new Result(whisper.use(engine -> engine.transcribe(mono16k)), Backend.WHISPER_TINY_EN);
    }

    private String recognizeOnDevice(float[] mono16k) throws Exception {
        ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
        Handler main = new Handler(Looper.getMainLooper());
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> text = new AtomicReference<>();
        AtomicReference<Exception> failure = new AtomicReference<>();
        AtomicReference<SpeechRecognizer> recognizer = new AtomicReference<>();

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US")
                .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe[0])
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, 16000);
        main.post(() -> {
            try {
                SpeechRecognizer created = SpeechRecognizer.createOnDeviceSpeechRecognizer(context);
                recognizer.set(created);
                created.setRecognitionListener(new Listener(text, failure, done));
                created.startListening(intent);
            } catch (RuntimeException error) {
                failure.set(new Unavailable(error.getMessage()));
                done.countDown();
            }
        });
        Thread writer = new Thread(() -> writePcm16(pipe[1], mono16k), "LocalTranscriber-audio");
        writer.start();
        try {
            long audioMs = mono16k.length * 1000L / 16000;
            if (!done.await(audioMs + 20_000, TimeUnit.MILLISECONDS)) {
                throw new IllegalStateException("On-device recognizer did not answer");
            }
        } finally {
            main.post(() -> {
                SpeechRecognizer created = recognizer.get();
                if (created != null) created.destroy();
            });
            pipe[0].close();
            writer.join(5_000);
        }
        if (failure.get() != null) throw failure.get();
        return text.get();
    }

    private static void writePcm16(ParcelFileDescriptor sink, float[] samples) {
        try (OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(sink)) {
            ByteBuffer block = ByteBuffer.allocate(3200).order(ByteOrder.LITTLE_ENDIAN);
            for (float sample : samples) {
                block.putShort((short) Math.round(Math.max(-1f, Math.min(1f, sample)) * 32767));
                if (!block.hasRemaining()) {
                    out.write(block.array(), 0, block.position());
                    block.clear();
                }
            }
            out.write(block.array(), 0, block.position());
        } catch (IOException ignored) {
            // The recognizer closed the pipe early; its listener reports the outcome.
        }
    }

    private static final class Listener implements RecognitionListener {
        private final AtomicReference<String> text;
        private final AtomicReference<Exception> failure;
        private final CountDownLatch done;

        Listener(AtomicReference<String> text, AtomicReference<Exception> failure, CountDownLatch done) {
            this.text = text;
            this.failure = failure;
            this.done = done;
        }

        @Override
        public void onResults(Bundle results) {
            ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            text.set(matches == null || matches.isEmpty() ? "" : matches.get(0).trim());
            done.countDown();
        }

        @Override
        public void onError(int error) {
            switch (error) {
                case SpeechRecognizer.ERROR_NO_MATCH:
                case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                    text.set("");
                    break;
                case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED:
                case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE:
                case SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT:
                case SpeechRecognizer.ERROR_SERVER_DISCONNECTED:
                    failure.set(new Unavailable("recognizer error " + error));
                    break;
                default:
                    failure.set(new IllegalStateException("On-device recognizer error " + error));
            }
            done.countDown();
        }

        @Override public void onReadyForSpeech(Bundle params) {}
        @Override public void onBeginningOfSpeech() {}
        @Override public void onRmsChanged(float rmsdB) {}
        @Override public void onBufferReceived(byte[] buffer) {}
        @Override public void onEndOfSpeech() {}
        @Override public void onPartialResults(Bundle partialResults) {}
        @Override public void onEvent(int eventType, Bundle params) {}
    }
}
