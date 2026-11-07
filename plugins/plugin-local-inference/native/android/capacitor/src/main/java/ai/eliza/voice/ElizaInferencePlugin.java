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
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Map;
import org.json.JSONObject;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * Capacitor transport for the inference plugin's single native session.
 *
 * <p>A host can subclass it, register the subclass under its own name and pass
 * its policy through the protected hooks: {@link #admit} (refuse a request),
 * {@link #configure} (set up the shared session), {@link #describe} (add to the
 * status), {@link #hear} (put its own recognizer in front of the session's ASR),
 * {@link #answerBeforeInstall}, {@link #failureCode}, {@link #resolved},
 * {@link #idleReleaseMillis} and {@link #cancelAll}. The defaults keep this
 * transport's behavior: Phonon-2 only, no platform recognizer.
 *
 * <p>Transcription runs on its own hearing worker, and the other requests on
 * the speech worker, so a host recognizer that takes a long time never holds
 * synthesis. Calls into the shared session still serialize on its lock.
 */
@CapacitorPlugin(name = "ElizaInference")
public class ElizaInferencePlugin extends Plugin {
    /** A speech language: a plain BCP 47 tag such as {@code en} or {@code es-US}. */
    private static final Pattern LANGUAGE = Pattern.compile("[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*");
    private final Map<String, Request> requests = new ConcurrentHashMap<>();
    private Models models;
    private volatile boolean destroyed;

    @Override
    public void load() {
        models = Models.get(getContext());
        models.idleMillis = idleReleaseMillis();
    }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        cancelAll();
        super.handleOnDestroy();
    }

    /** A host refused a request: the call rejects with this message and code. */
    public static final class Refusal extends Exception {
        public final String code;

        public Refusal(String message, String code) {
            super(message);
            this.code = code;
        }
    }

    /**
     * Runs on the worker just before each synthesize, transcribe, generate and
     * embed request, also one that waited in the queue. Throw {@link Refusal}
     * to reject it. The default admits every request.
     */
    protected void admit(PluginCall call) throws Refusal {}

    /**
     * Runs on the worker once for each shared session this transport opens,
     * before the session's first request, for example to set a speed range.
     * A failure fails that request only: later requests use the session as it
     * is and do not call this again. Process-wide settings that must precede
     * the first voice load, such as {@link ParadeeVoice#setThreadCount}, do
     * not belong here, since another consumer may already have loaded a voice;
     * set them in the host's {@link #load} instead.
     */
    protected void configure(InferenceSession session) throws Exception {}

    /**
     * Runs on the worker before status answers; a host may add or change
     * fields (for example its own recognizer's {@code transcription} and
     * {@code hearingLanguages}).
     */
    protected void describe(PluginCall call, JSObject status) throws Exception {}

    /**
     * Transcribes one admitted request and returns {text, engine, fellBack,
     * demoted}; the transport adds {@code ms}. The default uses only the
     * session's ASR (Phonon-2, English). A host may try its own recognizer
     * first and fall back to {@link Transcription#asr}.
     */
    protected JSObject hear(Transcription transcription) throws Exception {
        String language = transcription.language;
        if (language != null && !"en".equals(language) && !language.startsWith("en-")) {
            throw new Refusal("Transcription speaks English only", "LANGUAGE_UNAVAILABLE");
        }
        JSObject result = new JSObject();
        result.put("text", transcription.asr().trim());
        result.put("engine", "asr");
        // Keep the response shape for older consumers.
        result.put("fellBack", false);
        result.put("demoted", false);
        return result;
    }

    /**
     * True: status answers at once from the APK's bundle manifest and native
     * support, and the bundle installs on the speech worker after it answers.
     * The answer does not prove that the install will succeed; a failed install
     * fails the next request. False (the default): status answers after the
     * install, and an install failure rejects it. {@link #describe} then runs
     * on the bridge thread.
     */
    protected boolean answerBeforeInstall() { return false; }

    /**
     * The rejection code of a failed request. {@code code} is the transport's
     * code (SPEECH_FAILED, HEARING_FAILED or INFERENCE_FAILED) and
     * {@code failure} the cause. Cancellation and {@link Refusal} never come here.
     */
    protected String failureCode(String code, Throwable failure) { return code; }

    /**
     * Runs on the worker with a request's result just before it resolves, for
     * example to log its timing. A throw rejects the request.
     */
    protected void resolved(PluginCall call, JSObject result) throws Exception {}

    /**
     * Idle time after which this transport releases its hold on the models;
     * 0 or less keeps them until Android reports memory pressure. Read when
     * the plugin loads; it applies to the process-wide owner. Default 120 s.
     */
    protected long idleReleaseMillis() { return 120000; }

    /** Cancels every running and queued request of this bridge; each rejects as cancelled. */
    protected final void cancelAll() {
        for (Request request : requests.values()) request.cancel();
    }

    /** One admitted transcription request, for {@link #hear}. */
    protected final class Transcription {
        /** The recording: 16 kHz mono PCM16, little-endian. */
        public final byte[] pcm16;
        /** The caller's {@code speechLanguage} (a plain BCP 47 tag), or null. */
        public final String language;
        private final Request request;

        private Transcription(byte[] pcm16, String language, Request request) {
            this.pcm16 = pcm16;
            this.language = language;
            this.request = request;
        }

        /** The session's ASR on the recording, through this request: its cancel stops it. */
        public String asr() throws Exception {
            ByteBuffer input = ByteBuffer.wrap(pcm16).order(ByteOrder.LITTLE_ENDIAN);
            float[] pcm = new float[pcm16.length / 2];
            for (int i = 0; i < pcm.length; i++) pcm[i] = input.getShort() / 32768f;
            String heard = models.session(ElizaInferencePlugin.this, models.hearing, request).transcribe(pcm);
            if (heard == null) throw new IllegalStateException("Transcription unavailable");
            return heard;
        }

        /**
         * Makes {@code stop} this request's cancellation while the host's own
         * recognizer runs. Throws {@link CancellationException} when the request
         * was already cancelled.
         */
        public void cancelWith(Runnable stop) { request.begin(stop); }
    }

    private static final class Request {
        private boolean cancelled;
        private Runnable active;
        synchronized void begin(Runnable stop) {
            if (cancelled) throw new CancellationException();
            active = stop;
        }
        synchronized void cancel() {
            cancelled = true;
            if (active != null) active.run();
        }
        synchronized void finish() { active = null; }
        synchronized void check() {
            if (cancelled) throw new CancellationException();
        }
    }

    private interface Operation { JSObject run(Request request) throws Exception; }

    private void submit(PluginCall call, Operation operation) {
        submit(call, "INFERENCE_FAILED", models.speech, operation);
    }

    private void submit(PluginCall call, String failureCode, Models.Lane lane, Operation operation) {
        if (destroyed) { call.reject("Inference bridge closed", "BRIDGE_CLOSED"); return; }
        String id = call.getString("requestId", "");
        if (id.isEmpty()) { call.reject("Expected requestId", "INVALID_INPUT"); return; }
        if (requests.size() >= 64) { call.reject("Inference queue is full", "QUEUE_FULL"); return; }
        Request request = new Request();
        if (requests.putIfAbsent(id, request) != null) {
            call.reject("Request already pending", "DUPLICATE_REQUEST"); return;
        }
        lane.executor.execute(() -> {
            try {
                if (destroyed) throw new CancellationException();
                request.check();
                if (models.pressure) throw new IllegalStateException("Inference is releasing memory");
                admit(call);
                lane.active = request;
                JSObject result = operation.run(request);
                request.check();
                resolved(call, result);
                call.resolve(result);
            } catch (CancellationException cancelled) {
                call.reject("Inference cancelled", "CANCELLED");
            } catch (Refusal refused) {
                call.reject(refused.getMessage(), refused.code);
            } catch (Exception failure) {
                call.reject("Inference failed", failureCode(failureCode, failure), failure);
            } catch (LinkageError failure) {
                call.reject("Native inference could not load", failureCode(failureCode, failure),
                        new IllegalStateException(failure));
            } finally {
                request.finish();
                lane.active = null;
                requests.remove(id, request);
                models.lastActivity = SystemClock.elapsedRealtime();
            }
        });
    }

    /**
     * What this process can do: speech, transcription, and the languages it
     * speaks and hears. With {@code speechLanguage}, after it answers it also
     * loads that language's voice (and the ASR when transcription is "asr"),
     * so the first request does not wait for them. See
     * {@link #answerBeforeInstall} for when it answers.
     */
    @PluginMethod
    public void status(PluginCall call) {
        if (destroyed) { call.reject("Inference bridge closed", "BRIDGE_CLOSED"); return; }
        String warm = call.getString("speechLanguage");
        if (warm != null && !LANGUAGE.matcher(warm).matches()) { call.reject("Invalid speechLanguage", "INVALID_INPUT"); return; }
        if (answerBeforeInstall()) {
            JSObject result = statusResult(call, false);
            if (result == null) return;
            call.resolve(result);
            models.speech.executor.execute(() -> warm(warm, result));
            return;
        }
        models.speech.executor.execute(() -> {
            JSObject result = statusResult(call, true);
            if (result == null) return;
            call.resolve(result);
            warm(warm, result);
        });
    }

    /** The status, or null after rejecting {@code call}. {@code installed}: read the languages from the installed session. */
    private JSObject statusResult(PluginCall call, boolean installed) {
        try {
            if (destroyed) throw new IllegalStateException("Inference bridge closed");
            boolean packaged = packaged("manifest.json");
            InferenceSession.Client client = installed && packaged ? models.session(this, models.speech, null) : null;
            boolean speech = packaged && VoiceNative.nativeParadeeSupported() == 1;
            String transcription = packaged && packaged("asr/phonon-2-fv5.gguf") && VoiceNative.nativeAsrSupported() == 1 ? "asr" : "none";
            JSObject result = new JSObject();
            result.put("speech", speech);
            result.put("transcription", transcription);
            result.put("provider", "libelizainference");
            JSArray speaking = new JSArray();
            if (speech) {
                for (String language : client != null ? client.speechLanguages() : VoiceBundleAssets.packagedLanguages(getContext())) speaking.put(language);
            }
            result.put("speechLanguages", speaking);
            // Phonon-2 hears English only.
            JSArray hearing = new JSArray();
            if ("asr".equals(transcription)) hearing.put("en");
            result.put("hearingLanguages", hearing);
            describe(call, result);
            return result;
        } catch (Exception failure) {
            call.reject("Inference unavailable", "INFERENCE_UNAVAILABLE", failure);
        } catch (LinkageError failure) {
            call.reject("Native inference could not load", "INFERENCE_UNAVAILABLE",
                    new IllegalStateException(failure));
        }
        return null;
    }

    /**
     * Speech worker, after status answered: installs the bundle if status did
     * not, then loads the voice of {@code language} and, on the hearing
     * worker, the ASR when transcription is "asr".
     */
    private void warm(String language, JSObject status) {
        if (destroyed || models.pressure || !packaged("manifest.json")) return;
        try {
            InferenceSession.Client client = models.session(this, models.speech, null);
            if (language != null && status.optBoolean("speech") && client.speechLanguages().contains(language)) client.prepareVoice(language);
        } catch (Exception | LinkageError failure) {
            // The next request loads again and reports its own failure.
            Log.w("ElizaInference", "Speech warm-up failed: " + failure.getClass().getSimpleName());
            return;
        }
        if (language == null || !"asr".equals(status.optString("transcription"))) return;
        models.hearing.executor.execute(() -> {
            if (destroyed || models.pressure) return;
            try {
                models.session(this, models.hearing, null).prepareRecognition();
            } catch (Exception | LinkageError failure) {
                Log.w("ElizaInference", "Recognition warm-up failed: " + failure.getClass().getSimpleName());
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
        // The voice of `speechLanguage` (one of the status's speechLanguages); absent is English.
        String language = call.getString("speechLanguage");
        if (language != null && !LANGUAGE.matcher(language).matches()) { call.reject("Invalid speechLanguage", "INVALID_INPUT"); return; }
        submit(call, "SPEECH_FAILED", models.speech, request -> {
            InferenceSession.Client client = models.session(this, models.speech, request);
            if (language != null && !client.speechLanguages().contains(language)) {
                throw new Refusal("No voice for " + language, "LANGUAGE_UNAVAILABLE");
            }
            long start = SystemClock.elapsedRealtime();
            ParadeeVoice.Audio audio = client.synthesize(text, speed.floatValue(), language);
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
        String language = call.getString("speechLanguage");
        if (language != null && !LANGUAGE.matcher(language).matches()) { call.reject("Invalid speechLanguage", "INVALID_INPUT"); return; }
        submit(call, "HEARING_FAILED", models.hearing, request -> {
            long start = SystemClock.elapsedRealtime();
            JSObject result = hear(new Transcription(bytes, language, request));
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
            try (InferenceSession.TextStream stream = models.session(this, models.speech, request).openTextStream(prompt, maxTokens)) {
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
            for (float value : models.session(this, models.speech, request).embed(text, pooling)) vector.put(value);
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

    /** Bridges share the workers, context, idle policy and Android pressure listener. */
    private static final class Models implements ComponentCallbacks2 {
        /**
         * One worker and this transport's own client of the shared session. Each
         * lane has its own client, so cancelling a speech request never fences a
         * transcription, and the reverse.
         */
        static final class Lane {
            final ExecutorService executor;
            /** Written under the Models lock. */
            volatile InferenceSession.Client client;
            /** The request this lane runs; its worker thread only writes it. */
            volatile Request active;
            Lane(ExecutorService executor) { this.executor = executor; }
        }
        private static Models instance;
        /** The speech worker; it also runs the idle check and the memory release. */
        final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
        final Lane speech = new Lane(worker);
        final Lane hearing = new Lane(Executors.newSingleThreadExecutor());
        final Context context;
        volatile InferenceSession current;
        /** The session the host's configure hook last set up; guarded by this. */
        InferenceSession configured;
        /** Idle release delay; 0 or less never releases for idleness. */
        volatile long idleMillis = 120000;
        volatile boolean pressure;
        volatile long lastActivity = SystemClock.elapsedRealtime();
        static synchronized Models get(Context context) {
            if (instance == null) instance = new Models(context.getApplicationContext());
            return instance;
        }
        Models(Context context) {
            this.context = context;
            context.registerComponentCallbacks(this);
            worker.scheduleWithFixedDelay(this::trimIfIdle, 30, 30, TimeUnit.SECONDS);
        }
        /**
         * Speech worker: the idle release. The check and the release run under
         * this lock, which {@link #session} also takes, and the hearing worker
         * marks its lane active before it asks for the session. So a
         * transcription either is seen and keeps the models, or gets its client
         * only after the release and is not fenced by it.
         */
        synchronized void trimIfIdle() {
            long idle = idleMillis;
            if (idle > 0 && hearing.active == null && SystemClock.elapsedRealtime() - lastActivity >= idle) trim();
        }
        /** Either worker. The install and the host's configure run once, under this lock. */
        synchronized InferenceSession.Client session(ElizaInferencePlugin owner, Lane lane, Request request) throws Exception {
            if (request != null) request.check();
            // The process-wide owner, through this transport's own clients: other native
            // consumers (capture VAD, streamed speech) share its context lifecycle instead
            // of loading a second copy, and this transport's cancellation and idle or
            // memory-pressure release never fence or unload their calls.
            if (current == null || current.isClosed()) {
                InferenceSession next = VoiceAssets.sharedInference(context);
                if (next != configured) {
                    // Once per session: a failure fails this request only, and
                    // never fails every later request on the same session.
                    configured = next;
                    owner.configure(next);
                }
                current = next;
                speech.client = null;
                hearing.client = null;
            }
            if (lane.client == null) lane.client = current.client();
            InferenceSession.Client active = lane.client;
            if (request != null) request.begin(active::cancel);
            lastActivity = SystemClock.elapsedRealtime();
            return active;
        }
        /** Speech worker: drops both lanes' holds on the models. */
        void trim() {
            try {
                for (Lane lane : new Lane[] {speech, hearing}) {
                    InferenceSession.Client active = lane.client;
                    if (active != null) active.release();
                }
            } catch (RuntimeException failure) { Log.e("ElizaInference", "Native memory release failed", failure); }
            finally { pressure = false; }
        }
        void releasePressure() {
            pressure = true;
            for (Lane lane : new Lane[] {speech, hearing}) {
                Request request = lane.active;
                if (request != null) request.cancel();
                InferenceSession.Client active = lane.client;
                if (active != null) active.cancel();
            }
            worker.execute(this::trim);
        }
        @Override public void onTrimMemory(int level) {
            if (level == TRIM_MEMORY_RUNNING_LOW || level == TRIM_MEMORY_RUNNING_CRITICAL || level >= TRIM_MEMORY_BACKGROUND) releasePressure();
        }
        @Override public void onLowMemory() { releasePressure(); }
        @Override public void onConfigurationChanged(Configuration configuration) {}
    }
}
