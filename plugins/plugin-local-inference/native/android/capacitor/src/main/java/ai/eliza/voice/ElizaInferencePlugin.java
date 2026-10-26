package ai.eliza.voice;

import android.content.ComponentCallbacks2;
import android.content.Context;
import android.content.res.Configuration;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.UncheckedIOException;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Map;
import org.json.JSONObject;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** Capacitor transport for the inference plugin's single native session. */
@CapacitorPlugin(name = "ElizaInference")
public class ElizaInferencePlugin extends Plugin {
    private final Map<String, Request> requests = new ConcurrentHashMap<>();
    private Models models;
    private volatile boolean destroyed;

    @Override
    public void load() { models = Models.get(getContext()); }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        for (Request request : requests.values()) request.cancel();
        super.handleOnDestroy();
    }

    private static final class Request {
        private boolean cancelled;
        private InferenceSession active;
        private Runnable alternative;
        synchronized void begin(InferenceSession session) {
            if (cancelled) throw new CancellationException();
            active = session;
        }
        synchronized void cancel() {
            cancelled = true;
            if (active != null) active.cancel();
            if (alternative != null) alternative.run();
        }
        synchronized void alternative(Runnable cancel) {
            if (cancelled) { cancel.run(); throw new CancellationException(); }
            alternative = cancel;
        }
        synchronized void clearAlternative() { alternative = null; }
        synchronized void finish() { active = null; alternative = null; }
        synchronized void check() {
            if (cancelled) throw new CancellationException();
        }
    }

    private interface Operation { JSObject run(Request request) throws Exception; }

    private void submit(PluginCall call, Operation operation) {
        submit(call, "INFERENCE_FAILED", operation);
    }

    private void submit(PluginCall call, String failureCode, Operation operation) {
        if (destroyed) { call.reject("Inference bridge closed", "BRIDGE_CLOSED"); return; }
        String id = call.getString("requestId", "");
        if (id.isEmpty()) { call.reject("Expected requestId", "INVALID_INPUT"); return; }
        if (requests.size() >= 64) { call.reject("Inference queue is full", "QUEUE_FULL"); return; }
        Request request = new Request();
        if (requests.putIfAbsent(id, request) != null) {
            call.reject("Request already pending", "DUPLICATE_REQUEST"); return;
        }
        models.worker.execute(() -> {
            try {
                if (destroyed) throw new CancellationException();
                request.check();
                if (models.pressure) throw new IllegalStateException("Inference is releasing memory");
                models.activeRequest = request;
                JSObject result = operation.run(request);
                request.check();
                call.resolve(result);
            } catch (CancellationException cancelled) {
                call.reject("Inference cancelled", "CANCELLED");
            } catch (Exception failure) {
                call.reject("Inference failed", failureCode, failure);
            } catch (LinkageError failure) {
                call.reject("Native inference could not load", failureCode,
                        new IllegalStateException(failure));
            } finally {
                request.finish();
                models.activeRequest = null;
                requests.remove(id, request);
                models.lastActivity = SystemClock.elapsedRealtime();
            }
        });
    }

    @PluginMethod
    public void status(PluginCall call) {
        if (destroyed) { call.reject("Inference bridge closed", "BRIDGE_CLOSED"); return; }
        models.worker.execute(() -> {
            try {
                if (destroyed) throw new IllegalStateException("Inference bridge closed");
                boolean platform = OnDeviceRecognizer.available(getContext());
                boolean packaged = packaged("manifest.json");
                if (packaged) models.session(null);
                JSObject result = new JSObject();
                result.put("speech", packaged && VoiceNative.nativeParadeeSupported() == 1);
                result.put("transcription", platform ? "android" : packaged && packaged("asr/phonon-2-fv5.gguf") && VoiceNative.nativeAsrSupported() == 1 ? "asr" : "none");
                result.put("provider", "libelizainference");
                call.resolve(result);
            } catch (Exception failure) {
                call.reject("Inference unavailable", "INFERENCE_UNAVAILABLE", failure);
            } catch (LinkageError failure) {
                call.reject("Native inference could not load", "INFERENCE_UNAVAILABLE",
                        new IllegalStateException(failure));
            }
        });
    }

    @PluginMethod
    public void synthesize(PluginCall call) {
        String text = call.getString("text", "");
        Double speed = call.getDouble("speed", 1.0);
        if (text.trim().isEmpty() || text.length() > 2000 || speed == null || !(speed >= 0.5 && speed <= 2.0)) {
            call.reject("Expected 1 to 2000 text characters and speed 0.5 to 2", "INVALID_INPUT"); return;
        }
        submit(call, "SPEECH_FAILED", request -> {
            long start = SystemClock.elapsedRealtime();
            ParadeeVoice.Audio audio = models.session(request).synthesize(text, speed.floatValue());
            JSObject result = new JSObject();
            result.put("audioBase64", Base64.encodeToString(wav(audio), Base64.NO_WRAP));
            result.put("sampleRate", audio.sampleRate);
            result.put("seconds", audio.seconds());
            result.put("ms", SystemClock.elapsedRealtime() - start);
            return result;
        });
    }

    @PluginMethod
    public void transcribe(PluginCall call) {
        String encoded = call.getString("pcm16Base64", "");
        Integer rate = call.getInt("sampleRate", 16000);
        if (rate == null || rate != 16000 || encoded.isEmpty() || encoded.length() > 2560000) {
            call.reject("Expected at most one minute of 16 kHz mono PCM16", "INVALID_INPUT"); return;
        }
        final byte[] bytes;
        try { bytes = Base64.decode(encoded, Base64.NO_WRAP); }
        catch (IllegalArgumentException invalid) { call.reject("Invalid PCM16", "INVALID_INPUT"); return; }
        if (bytes.length == 0 || bytes.length % 2 != 0 || bytes.length > 1920000) {
            call.reject("Expected complete PCM16 samples, at most one minute", "INVALID_INPUT"); return;
        }
        submit(call, "HEARING_FAILED", request -> {
            ByteBuffer input = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
            float[] pcm = new float[bytes.length / 2];
            for (int i = 0; i < pcm.length; i++) pcm[i] = input.getShort() / 32768f;
            long start = SystemClock.elapsedRealtime();
            TranscriptionRoute.Heard heard = TranscriptionRoute.transcribe(bytes,
                    OnDeviceRecognizer.available(getContext()),
                    () -> {
                        OnDeviceRecognizer recognizer = new OnDeviceRecognizer(getContext());
                        request.alternative(recognizer::cancel);
                        try { return recognizer.transcribe(bytes, TranscriptionRoute.limitMillis(bytes.length)); }
                        finally { request.clearAlternative(); }
                    },
                    () -> {
                        request.check();
                        try { return models.session(request).transcribe(pcm); }
                        catch (IOException failure) { throw new UncheckedIOException(failure); }
                    }, OnDeviceRecognizer::demote, line -> Log.i("ElizaInference", line));
            if (heard == null) throw new IllegalStateException("Transcription unavailable");
            JSObject result = new JSObject();
            result.put("text", heard.text == null ? "" : heard.text.trim());
            result.put("engine", heard.engine);
            result.put("fellBack", heard.fellBack);
            result.put("demoted", heard.demoted);
            result.put("ms", SystemClock.elapsedRealtime() - start);
            return result;
        });
    }

    /** Fails explicitly when the installed bundle has no text model. */
    @PluginMethod
    public void generate(PluginCall call) {
        String prompt = call.getString("prompt", "");
        Integer maxTokens = call.getInt("maxTokens");
        if (prompt.isEmpty() || maxTokens == null || maxTokens <= 0) {
            call.reject("Expected prompt and positive maxTokens", "INVALID_INPUT"); return;
        }
        submit(call, request -> {
            JSObject result = new JSObject();
            StringBuilder text = new StringBuilder();
            try (InferenceSession.TextStream stream = models.session(request).openTextStream(prompt, maxTokens)) {
                while (true) {
                    JSONObject step = new JSONObject(stream.next());
                    text.append(step.getString("text"));
                    if (step.getBoolean("done")) break;
                }
            }
            result.put("text", text.toString());
            return result;
        });
    }

    @PluginMethod
    public void embed(PluginCall call) {
        String text = call.getString("text", "");
        Integer pooling = call.getInt("pooling", 1);
        if (text.isEmpty() || pooling == null || pooling < 1 || pooling > 3) {
            call.reject("Expected text and pooling 1, 2 or 3", "INVALID_INPUT"); return;
        }
        submit(call, request -> {
            JSArray vector = new JSArray();
            for (float value : models.session(request).embed(text, pooling)) vector.put(value);
            JSObject result = new JSObject(); result.put("embedding", vector); return result;
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Request request = requests.get(call.getString("requestId", ""));
        if (request != null) request.cancel();
        JSObject result = new JSObject(); result.put("cancelled", request != null); call.resolve(result);
    }

    private boolean packaged(String path) {
        try (java.io.InputStream ignored = getContext().getAssets().open(VoiceAssets.ASSET_ROOT + "/" + path)) {
            return true;
        } catch (IOException absent) {
            return false;
        }
    }

    private static byte[] wav(ParadeeVoice.Audio audio) {
        int bytes = Math.multiplyExact(audio.samples.length, 2);
        ByteBuffer out = ByteBuffer.allocate(Math.addExact(44, bytes)).order(ByteOrder.LITTLE_ENDIAN);
        out.putInt(0x46464952).putInt(36 + bytes).putInt(0x45564157);
        out.putInt(0x20746d66).putInt(16).putShort((short) 1).putShort((short) 1);
        out.putInt(audio.sampleRate).putInt(audio.sampleRate * 2).putShort((short) 2).putShort((short) 16);
        out.putInt(0x61746164).putInt(bytes);
        for (float value : audio.samples) out.putShort((short) Math.round(Math.max(-1f, Math.min(1f, value)) * (value < 0 ? 32768 : 32767)));
        return out.array();
    }

    /** Bridges share one queue, context, idle policy and Android pressure listener. */
    private static final class Models implements ComponentCallbacks2 {
        private static Models instance;
        final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
        final Context context;
        volatile InferenceSession current;
        volatile Request activeRequest;
        volatile boolean pressure;
        volatile long lastActivity = SystemClock.elapsedRealtime();
        static synchronized Models get(Context context) {
            if (instance == null) instance = new Models(context.getApplicationContext());
            return instance;
        }
        Models(Context context) {
            this.context = context;
            context.registerComponentCallbacks(this);
            worker.scheduleWithFixedDelay(() -> {
                if (SystemClock.elapsedRealtime() - lastActivity >= 120000) trim();
            }, 30, 30, TimeUnit.SECONDS);
        }
        InferenceSession session(Request request) throws IOException {
            if (request != null) request.check();
            if (current == null) current = VoiceAssets.install(context).openInference();
            if (request != null) request.begin(current);
            lastActivity = SystemClock.elapsedRealtime();
            return current;
        }
        void trim() {
            try { if (current != null) current.trimMemory(); }
            catch (RuntimeException failure) { Log.e("ElizaInference", "Native memory release failed", failure); }
            finally { pressure = false; }
        }
        void releasePressure() {
            pressure = true;
            Request request = activeRequest;
            if (request != null) request.cancel();
            InferenceSession session = current;
            if (session != null) session.cancel();
            worker.execute(this::trim);
        }
        @Override public void onTrimMemory(int level) {
            if (level == TRIM_MEMORY_RUNNING_LOW || level == TRIM_MEMORY_RUNNING_CRITICAL || level >= TRIM_MEMORY_BACKGROUND) releasePressure();
        }
        @Override public void onLowMemory() { releasePressure(); }
        @Override public void onConfigurationChanged(Configuration configuration) {}
    }
}
