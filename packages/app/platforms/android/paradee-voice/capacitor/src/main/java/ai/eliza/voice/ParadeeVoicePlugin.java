package ai.eliza.voice;

import android.content.Context;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Locale;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/**
 * Capacitor plugin for the packaged Paradee voice bundle. Speech uses
 * {@link ParadeeVoice}. Transcription uses {@link OnDeviceRecognizer} when
 * Android has an on-device English model, else {@link NativeAsr} from the
 * bundle's {@code asr/} ({@link TranscriptionRoute}). Everything runs in the
 * app process, with no network. The plugin does not log or keep text or audio.
 *
 * <p>Capacitor creates the plugin again with each bridge, so the models and
 * their worker threads belong to the process ({@link Models}).
 */
@CapacitorPlugin(name = "ParadeeVoice")
public final class ParadeeVoicePlugin extends Plugin {
    private static final String TAG = "ParadeeVoice";
    private static final String ASR_MODEL = "phonon-2-fv5.gguf";
    private static final int MAX_TEXT_CHARS = 2000;
    /** One minute of 16 kHz 16-bit mono audio. */
    private static final int MAX_PCM_BYTES = NativeAsr.SAMPLE_RATE * 2 * 60;

    private final RequestCancels cancels = new RequestCancels();
    private Models models;

    @Override
    public void load() {
        models = Models.get(getContext());
        models.forgetVoiceFailure();
    }

    /**
     * What the packaged bundle can do, read from the APK without waiting for
     * the install. {@code speech} is a boolean. {@code transcription} is
     * "android", "asr" or "none". The install and model load start now on the
     * worker threads.
     */
    @PluginMethod
    public void status(PluginCall call) {
        boolean packaged = packaged("manifest.json");
        String transcription = OnDeviceRecognizer.available(getContext())
                ? "android"
                : packaged && packaged("asr/" + ASR_MODEL) ? "asr" : "none";
        if (packaged && !models.onSpeech(models::voice)) {
            call.reject("The voice is not available", "VOICE_UNAVAILABLE");
            return;
        }
        if ("asr".equals(transcription)) models.onHearing(models::asr);
        JSObject result = new JSObject();
        result.put("speech", packaged && !models.voiceFailed());
        result.put("transcription", transcription);
        call.resolve(result);
    }

    /**
     * Speaks {@code text} at {@code speed} (0.5 to 2.0). Resolves with a mono
     * 16-bit WAV in {@code audioBase64}, its {@code sampleRate} and
     * {@code seconds}, and the synthesis time in {@code ms}.
     */
    @PluginMethod
    public void synthesize(PluginCall call) {
        String id = call.getString("requestId", "");
        String text = call.getString("text", "");
        Double speed = call.getDouble("speed", 1.0);
        if (id.isEmpty() || text.trim().isEmpty() || text.length() > MAX_TEXT_CHARS
                || speed == null || !(speed >= 0.5 && speed <= 2.0)) {
            call.reject("Expected requestId, text of 1 to " + MAX_TEXT_CHARS + " characters and speed 0.5 to 2.0");
            return;
        }
        cancels.queue(id);
        boolean queued = models.onSpeech(() -> {
            try {
                ParadeeVoice voice = models.voice();
                if (voice == null) {
                    call.reject("The voice is not available", "VOICE_UNAVAILABLE");
                    return;
                }
                cancels.running(id, voice::cancel);
                long started = SystemClock.elapsedRealtime();
                ParadeeVoice.Audio audio = voice.synthesize(text, speed.floatValue());
                long ms = SystemClock.elapsedRealtime() - started;
                JSObject result = new JSObject();
                result.put("audioBase64", Base64.encodeToString(wav(audio.samples, audio.sampleRate), Base64.NO_WRAP));
                result.put("sampleRate", audio.sampleRate);
                result.put("seconds", audio.seconds());
                result.put("ms", ms);
                Log.i(TAG, String.format(Locale.ROOT, "tts chars=%d audio=%.2fs synth=%dms",
                        text.length(), audio.seconds(), ms));
                call.resolve(result);
            } catch (CancellationException stopped) {
                call.reject("Speech cancelled", "CANCELLED");
            } catch (RuntimeException failure) {
                Log.w(TAG, "tts failed: " + failure.getClass().getSimpleName());
                call.reject("The voice could not speak", "VOICE_FAILED");
            } finally {
                cancels.finish(id);
            }
        });
        if (!queued) {
            cancels.finish(id);
            call.reject("The voice is not available", "VOICE_UNAVAILABLE");
        }
    }

    /**
     * Transcribes {@code pcm16Base64}: 16 kHz mono 16-bit little-endian PCM,
     * up to one minute ({@code sampleRate} must be 16000). Resolves with
     * {@code text}, {@code engine} ("android" or "asr"), {@code fellBack},
     * {@code demoted} and {@code ms}.
     */
    @PluginMethod
    public void transcribe(PluginCall call) {
        String id = call.getString("requestId", "");
        Integer rate = call.getInt("sampleRate", 0);
        byte[] pcm;
        try {
            pcm = Base64.decode(call.getString("pcm16Base64", ""), Base64.DEFAULT);
        } catch (IllegalArgumentException invalid) {
            pcm = new byte[0];
        }
        if (id.isEmpty() || rate == null || rate != NativeAsr.SAMPLE_RATE
                || pcm.length < 2 || pcm.length > MAX_PCM_BYTES || pcm.length % 2 != 0) {
            call.reject("Expected requestId and up to one minute of 16 kHz mono PCM16");
            return;
        }
        final byte[] audio = pcm;
        Context context = getContext();
        cancels.queue(id);
        boolean queued = models.onHearing(() -> {
            long started = SystemClock.elapsedRealtime();
            try {
                TranscriptionRoute.Heard heard = TranscriptionRoute.transcribe(
                        audio,
                        OnDeviceRecognizer.available(context),
                        () -> {
                            OnDeviceRecognizer recognizer = new OnDeviceRecognizer(context);
                            cancels.running(id, recognizer::cancel);
                            return recognizer.transcribe(audio, TranscriptionRoute.limitMillis(audio.length));
                        },
                        () -> {
                            NativeAsr asr = models.asr();
                            if (asr == null) return null;
                            cancels.running(id, asr::cancel);
                            return asr.transcribe(floats(audio));
                        },
                        OnDeviceRecognizer::demote,
                        line -> Log.i(TAG, line));
                if (heard == null) {
                    call.reject("Transcription is not available", "HEARING_UNAVAILABLE");
                    return;
                }
                long ms = SystemClock.elapsedRealtime() - started;
                Log.i(TAG, String.format(Locale.ROOT, "stt engine=%s audio=%.2fs took=%dms",
                        heard.engine, audio.length / 2.0 / NativeAsr.SAMPLE_RATE, ms));
                JSObject result = new JSObject();
                result.put("text", heard.text == null ? "" : heard.text.trim());
                result.put("engine", heard.engine);
                result.put("fellBack", heard.fellBack);
                result.put("demoted", heard.demoted);
                result.put("ms", ms);
                call.resolve(result);
            } catch (CancellationException stopped) {
                call.reject("Transcription cancelled", "CANCELLED");
            } catch (RuntimeException failure) {
                Log.w(TAG, "stt failed: " + failure.getClass().getSimpleName());
                call.reject("The audio could not be transcribed", "HEARING_FAILED");
            } finally {
                cancels.finish(id);
            }
        });
        if (!queued) {
            cancels.finish(id);
            call.reject("Transcription is not available", "HEARING_UNAVAILABLE");
        }
    }

    /** Cancels the queued or running request {@code requestId}; it rejects with CANCELLED. */
    @PluginMethod
    public void cancel(PluginCall call) {
        cancels.cancel(call.getString("requestId", ""));
        call.resolve();
    }

    /** The page is gone: its requests stop. The models stay loaded for the next bridge. */
    @Override
    protected void handleOnDestroy() {
        cancels.cancelAll();
    }

    private boolean packaged(String path) {
        try (InputStream ignored = getContext().getAssets().open(VoiceAssets.ASSET_ROOT + "/" + path)) {
            return true;
        } catch (IOException missing) {
            return false;
        }
    }

    static float[] floats(byte[] pcm16) {
        ByteBuffer buffer = ByteBuffer.wrap(pcm16).order(ByteOrder.LITTLE_ENDIAN);
        float[] out = new float[pcm16.length / 2];
        for (int i = 0; i < out.length; i++) out[i] = buffer.getShort() / 32768f;
        return out;
    }

    /** Mono 16-bit PCM WAV of samples in [-1, 1]. */
    static byte[] wav(float[] samples, int sampleRate) {
        ByteBuffer out = ByteBuffer.allocate(44 + samples.length * 2).order(ByteOrder.LITTLE_ENDIAN);
        out.put(new byte[] {'R', 'I', 'F', 'F'}).putInt(36 + samples.length * 2);
        out.put(new byte[] {'W', 'A', 'V', 'E', 'f', 'm', 't', ' '});
        out.putInt(16).putShort((short) 1).putShort((short) 1).putInt(sampleRate).putInt(sampleRate * 2);
        out.putShort((short) 2).putShort((short) 16);
        out.put(new byte[] {'d', 'a', 't', 'a'}).putInt(samples.length * 2);
        for (float sample : samples) out.putShort((short) Math.round(Math.max(-1f, Math.min(1f, sample)) * 32767f));
        return out.array();
    }

    /**
     * The process's voice and ASR, each loaded once and kept, on one speech
     * thread and one hearing thread. Plugin instances only borrow them.
     */
    static final class Models {
        private static Models shared;

        static synchronized Models get(Context context) {
            if (shared == null) shared = new Models(context.getApplicationContext());
            return shared;
        }

        private final Context context;
        private final ExecutorService speech = Executors.newSingleThreadExecutor(r -> daemon(r, "paradee-speech"));
        private final ExecutorService hearing = Executors.newSingleThreadExecutor(r -> daemon(r, "paradee-hearing"));
        private ParadeeVoice voice;
        private NativeAsr asr;
        private volatile boolean voiceFailed;

        private Models(Context context) {
            this.context = context;
        }

        private static Thread daemon(Runnable work, String name) {
            Thread thread = new Thread(work, name);
            thread.setDaemon(true);
            return thread;
        }

        boolean onSpeech(Runnable work) {
            return run(speech, work);
        }

        boolean onHearing(Runnable work) {
            return run(hearing, work);
        }

        private static boolean run(ExecutorService thread, Runnable work) {
            try {
                thread.execute(work);
                return true;
            } catch (RejectedExecutionException stopped) {
                return false;
            }
        }

        boolean voiceFailed() {
            return voiceFailed;
        }

        /** A new bridge may try a voice that failed to load again. */
        void forgetVoiceFailure() {
            voiceFailed = false;
        }

        /** Speech thread only. Null when the bundle cannot be installed or loaded. */
        ParadeeVoice voice() {
            if (voice != null || voiceFailed) return voice;
            try {
                voice = VoiceAssets.install(context).openVoice();
            } catch (IOException | RuntimeException | LinkageError failure) {
                Log.w(TAG, "voice unavailable: " + failure.getClass().getSimpleName());
                voiceFailed = true;
            }
            return voice;
        }

        /** Hearing thread only. Null when the bundle has no usable ASR. */
        NativeAsr asr() {
            if (asr != null) return asr;
            try {
                asr = VoiceAssets.install(context).openAsr();
            } catch (IOException | RuntimeException | LinkageError failure) {
                Log.w(TAG, "asr unavailable: " + failure.getClass().getSimpleName());
            }
            return asr;
        }
    }
}
