package ai.eliza.voice;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * On-device speech with a Paradee-family model in {@code libelizainference}:
 * English Paradee-8M (misaki G2P) or, through a voice slot, Castilian Spanish
 * Delibes-8M-esES (eSpeak NG G2P). Text becomes phonemes natively; long text is
 * split into model-sized chunks natively. 24 kHz audio, in this process, with
 * no agent, server, account or network use.
 *
 * <p>The public constructor loads the context's default (ABI v17) voice.
 * {@link #slot} loads a voice into a named slot (ABI v20), so one context can
 * hold an English and a Spanish voice at the same time; {@link #language} says
 * which language a voice speaks.
 *
 * <p>One instance owns one loaded model (about 40 MB resident). Synthesis
 * calls are serialized; run them on a worker thread, never on the Android
 * main thread. {@link #cancel} may be called from any thread and makes the
 * running call and every waiting call throw
 * {@link java.util.concurrent.CancellationException}; a {@link Request} cancels
 * one non-streaming call and no other.
 */
public final class ParadeeVoice implements AutoCloseable {
    /** {@link #g2pKind}: the lexicon has no fallback for unknown words. */
    public static final int G2P_LEXICON_ONLY = 0;
    /** {@link #g2pKind}: unknown words use native letter-to-sound rules. */
    public static final int G2P_RULES = 1;
    /** {@link #g2pKind}: unknown words use eSpeak NG, converted to misaki spelling. */
    public static final int G2P_ESPEAK = 2;

    /** Model output: mono float PCM in [-1, 1] at {@link #sampleRate}. */
    public static final class Audio {
        public final float[] samples;
        public final int sampleRate;

        Audio(float[] samples, int sampleRate) {
            this.samples = samples;
            this.sampleRate = sampleRate;
        }

        public double seconds() {
            return samples.length / (double) sampleRate;
        }
    }

    /** True once any voice loaded in this process; the native speech thread pool is fixed then. */
    private static boolean anyLoaded; // Guarded by ParadeeVoice.class.

    /**
     * Sets how many threads speech synthesis uses in this process. The native
     * library reads the count once, when the first voice loads, so call this
     * before that; afterwards it throws {@link IllegalStateException}. Without
     * it the library uses one thread per core (at most 16). {@code threads}
     * must be 1 to 64.
     */
    public static synchronized void setThreadCount(int threads) {
        if (threads < 1 || threads > 64) throw new IllegalArgumentException("Expected 1 to 64 speech threads");
        if (anyLoaded) throw new IllegalStateException("Speech threads are fixed once a voice has loaded");
        VoiceNative.setSpeechThreads(threads);
    }

    private static synchronized void loaded() {
        anyLoaded = true;
    }

    /** Guards the context pointer so cancel never signals a freed context. */
    private final Object handleLock = new Object();
    private long handle;
    private final boolean ownsContext;
    private final AtomicLong generation = new AtomicLong();
    private boolean streaming;
    private volatile boolean closing;
    private volatile Thread streamingThread;
    private final int sampleRate;
    private final int g2pKind;
    /** Null for the default (v17) voice, else the ABI v20 slot this voice occupies. */
    private final String voiceId;
    private final String language;

    /**
     * Loads the model.
     *
     * @param model the Paradee GGUF, for example {@code paradee-8m-v1_2.gguf}
     * @param lexicon the misaki lexicon, {@code misaki-en-us.lex}
     * @param espeakDir the directory that contains {@code espeak-ng-data}, or
     *     null to keep G2P to the lexicon and its rules
     */
    public ParadeeVoice(File model, File lexicon, File espeakDir) throws IOException {
        this(model, lexicon, espeakDir, 0L);
    }

    ParadeeVoice(File model, File lexicon, File espeakDir, long sharedContext) throws IOException {
        ownsContext = sharedContext == 0L;
        for (File file : new File[] {model, lexicon}) {
            if (!file.isFile()) throw new IOException("Missing Paradee file " + file);
        }
        if (espeakDir != null && !new File(espeakDir, "espeak-ng-data/en_dict").isFile()) {
            throw new IOException("Missing eSpeak NG English data under " + espeakDir);
        }
        if (VoiceNative.nativeParadeeSupported() != 1) {
            throw new IllegalStateException("libelizainference was built without Paradee (LLAMA_BUILD_PARADEE=OFF)");
        }
        long ctx = ownsContext ? VoiceNative.nativeContextCreate(model.getParentFile().getAbsolutePath()) : sharedContext;
        try {
            VoiceNative.nativeParadeeLoad(ctx, model.getAbsolutePath(), lexicon.getAbsolutePath(),
                    espeakDir == null ? null : espeakDir.getAbsolutePath());
            sampleRate = VoiceNative.nativeParadeeSampleRate(ctx);
            g2pKind = VoiceNative.nativeParadeeG2pKind(ctx);
        } catch (RuntimeException error) {
            if (ownsContext) VoiceNative.nativeContextDestroy(ctx);
            throw new IOException("Paradee model load failed", error);
        }
        voiceId = null;
        language = "en";
        handle = ctx;
        loaded();
    }

    /**
     * Loads a voice into slot {@code voiceId} of its own context.
     *
     * @param model a Paradee-family GGUF: Paradee-8M (English) or Delibes-8M-esES (Spanish)
     * @param lexicon the misaki lexicon for an English model; null for a Spanish one
     * @param espeakDir the directory that contains {@code espeak-ng-data}; required for
     *     Spanish (it needs {@code es_dict}), optional for English
     * @param voiceId a non-empty slot name, for example {@code "es"}
     */
    public static ParadeeVoice slot(File model, File lexicon, File espeakDir, String voiceId) throws IOException {
        return new ParadeeVoice(model, lexicon, espeakDir, voiceId, 0L);
    }

    ParadeeVoice(File model, File lexicon, File espeakDir, String voiceId, long sharedContext) throws IOException {
        if (voiceId == null || voiceId.isEmpty()) throw new IllegalArgumentException("Expected a voice id");
        ownsContext = sharedContext == 0L;
        if (!model.isFile()) throw new IOException("Missing Paradee file " + model);
        if (lexicon != null && !lexicon.isFile()) throw new IOException("Missing Paradee file " + lexicon);
        if (espeakDir != null && !new File(espeakDir, "espeak-ng-data/phontab").isFile()) {
            throw new IOException("Missing eSpeak NG data under " + espeakDir);
        }
        if (VoiceNative.nativeParadeeSupported() != 1 || VoiceNative.nativeParadeeVoicesSupported() != 1) {
            throw new IllegalStateException("libelizainference has no Paradee voice slots (ABI 20)");
        }
        long ctx = ownsContext ? VoiceNative.nativeContextCreate(model.getParentFile().getAbsolutePath()) : sharedContext;
        try {
            VoiceNative.nativeParadeeLoadVoice(ctx, voiceId, model.getAbsolutePath(),
                    lexicon == null ? null : lexicon.getAbsolutePath(),
                    espeakDir == null ? null : espeakDir.getAbsolutePath(), null);
            String info = VoiceNative.nativeParadeeVoiceInfo(ctx, voiceId);
            sampleRate = Integer.parseInt(infoField(info, "sample_rate"));
            g2pKind = Integer.parseInt(infoField(info, "g2p_kind"));
            language = infoField(info, "language");
        } catch (RuntimeException error) {
            if (ownsContext) VoiceNative.nativeContextDestroy(ctx);
            else VoiceNative.nativeParadeeUnloadVoice(ctx, voiceId);
            throw new IOException("Paradee voice " + voiceId + " load failed", error);
        }
        this.voiceId = voiceId;
        handle = ctx;
        loaded();
    }

    /** A scalar field of the native voice-info JSON (a number or a plain string). */
    static String infoField(String json, String key) {
        Matcher m = Pattern.compile("\"" + Pattern.quote(key) + "\":(?:\"([^\"]*)\"|(-?[0-9.]+))").matcher(json == null ? "" : json);
        if (!m.find()) throw new IllegalStateException("Paradee voice info has no " + key);
        return m.group(1) != null ? m.group(1) : m.group(2);
    }

    /** The language this voice speaks: {@code "en"} or {@code "es"}. */
    public String language() {
        return language;
    }

    /** The slot this voice occupies, or null for the context's default voice. */
    public String voiceId() {
        return voiceId;
    }

    public int sampleRate() {
        return sampleRate;
    }

    /** One of {@link #G2P_LEXICON_ONLY}, {@link #G2P_RULES}, {@link #G2P_ESPEAK}. */
    public int g2pKind() {
        return g2pKind;
    }

    /** Text to the model's input phonemes (misaki for English, eSpeak NG es for Spanish). */
    public synchronized String phonemize(String text) {
        long ctx = check();
        return voiceId == null ? VoiceNative.nativeParadeePhonemize(ctx, bytes(text))
                : VoiceNative.nativeParadeePhonemizeVoice(ctx, voiceId, bytes(text));
    }

    /** The slowest and fastest rate {@link #speedRange} accepts (the architecture's limits). */
    public static final float MIN_SPEED = 0.25f, MAX_SPEED = 4.0f;

    /**
     * Sets the range {@link #synthesize} and {@link #synthesizeStream} clamp
     * {@code speed} to, replacing the model's validated range (Delibes: 0.85 to
     * 1.15; Paradee: the architecture's limits). {@code min} and {@code max} must
     * satisfy {@link #MIN_SPEED} &lt;= min &lt;= 1 &lt;= max &lt;= {@link #MAX_SPEED};
     * a rate outside the validated range was not validated by the model's release,
     * so the caller owns that choice. The model file is unchanged, and the range
     * survives {@link #trimMemory}. Needs libelizainference ABI 21.
     */
    public synchronized void speedRange(float min, float max) {
        checkSpeedRange(min, max);
        VoiceNative.nativeParadeeSetVoiceSpeedRange(check(), voiceId == null ? "" : voiceId, min, max);
    }

    static void checkSpeedRange(float min, float max) {
        if (!(min >= MIN_SPEED && min <= 1f && max >= 1f && max <= MAX_SPEED)) {
            throw new IllegalArgumentException("Expected " + MIN_SPEED + " <= min <= 1 <= max <= " + MAX_SPEED);
        }
    }

    /** Restores the model's validated speed range (undoes {@link #speedRange}). */
    public synchronized void validatedSpeedRange() {
        VoiceNative.nativeParadeeSetVoiceSpeedRange(check(), voiceId == null ? "" : voiceId, 0f, 0f);
    }

    /**
     * Cancels one non-streaming request and no other: pass it to
     * {@link #synthesize(String, float, Request)} or
     * {@link #synthesizePhonemes(String, float, Request)}, and call
     * {@link #cancel} from any thread. A request waiting for the voice ends
     * cancelled without running; a running one is interrupted in native code
     * only while it is the voice's running call, so another request on the same
     * voice is never stopped. A cancelled request stays cancelled: a later call
     * with it throws {@link CancellationException} at once. Use one request for
     * one call at a time.
     */
    public static final class Request {
        private volatile boolean cancelled;
        private volatile ParadeeVoice running;

        public void cancel() {
            cancelled = true;
            ParadeeVoice voice = running;
            if (voice != null) voice.interrupt(this);
        }

        public boolean isCancelled() {
            return cancelled;
        }
    }

    /** The request in native code now, or null. Guarded by {@link #handleLock}. */
    private Request runningRequest;

    private void interrupt(Request request) {
        synchronized (handleLock) {
            if (runningRequest == request && handle != 0) VoiceNative.nativeCancelTts(handle);
        }
    }

    /**
     * Speaks text in this voice's language. {@code speed} 1.0 is the model's own
     * rate; it is clamped to the voice's speed range: the model's validated range
     * (Delibes: 0.85 to 1.15) unless {@link #speedRange} set another.
     */
    public Audio synthesize(String text, float speed) {
        return synthesize(text, speed, null);
    }

    /**
     * {@link #synthesize(String, float)} that {@code request} (or {@link #cancel})
     * can cancel; null is no request.
     */
    public Audio synthesize(String text, float speed, Request request) {
        final long admitted = generation.get();
        synchronized (this) {
            long ctx = check();
            byte[] input = bytes(text);
            return run(admitted, request, () -> voiceId == null ? VoiceNative.nativeParadeeSynthesize(ctx, input, speed)
                    : VoiceNative.nativeParadeeSynthesizeVoice(ctx, voiceId, input, speed));
        }
    }

    /** Speaks text that is already in misaki phonemes (the default voice only). */
    public Audio synthesizePhonemes(String phonemes, float speed) {
        return synthesizePhonemes(phonemes, speed, null);
    }

    /** {@link #synthesizePhonemes(String, float)} that {@code request} can cancel; null is no request. */
    public Audio synthesizePhonemes(String phonemes, float speed, Request request) {
        if (voiceId != null) throw new IllegalStateException("Phoneme input is available on the default voice only");
        final long admitted = generation.get();
        synchronized (this) {
            long ctx = check();
            byte[] input = bytes(phonemes);
            return run(admitted, request, () -> VoiceNative.nativeParadeeSynthesizePhonemes(ctx, input, speed));
        }
    }

    private interface NativeCall {
        float[] run();
    }

    /**
     * Caller holds this voice's lock. Runs a call admitted at {@code admitted}
     * and marks its request as the running one while it is in native code. The
     * library clears its cancel flag when a call enters, so a cancel that lands
     * between admission and that point does not stop the native call; the call
     * still ends cancelled and its audio is discarded.
     */
    private Audio run(long admitted, Request request, NativeCall call) {
        if (request != null) {
            // Marked before the cancelled check: a cancel either is seen here or finds the marker.
            request.running = this;
            synchronized (handleLock) {
                runningRequest = request;
            }
        }
        try {
            if (generation.get() != admitted || request != null && request.cancelled) throw new CancellationException();
            float[] pcm = call.run();
            if (generation.get() != admitted || request != null && request.cancelled) throw new CancellationException();
            return new Audio(pcm, sampleRate);
        } finally {
            if (request != null) {
                synchronized (handleLock) {
                    runningRequest = null;
                }
                request.running = null;
            }
        }
    }

    /** Receives native model chunks on the synthesis worker. Return false to cancel. */
    public interface PcmSink {
        boolean onChunk(float[] samples, boolean complete);
    }

    private final class NativeSink implements PcmSink {
        private final long admitted;
        private final PcmSink sink;
        NativeSink(long admitted, PcmSink sink) { this.admitted = admitted; this.sink = sink; }
        public boolean onChunk(float[] samples, boolean complete) {
            if (closing || generation.get() != admitted) return false;
            boolean keep = sink.onChunk(samples, complete);
            return keep && !closing && generation.get() == admitted;
        }
    }

    public boolean supportsStreaming() {
        return VoiceNative.nativeParadeeStreamSupported() == 1;
    }

    /**
     * Delivers model chunks without accumulating the whole utterance. Each array
     * holds at most 24,000 mono samples. The final callback has an empty array.
     * The return/exception is authoritative; flush queued playback on failure.
     * The sink must not reenter this voice except to cancel. Cancellation invalidates
     * calls already waiting for the synthesis lock and every later callback.
     */
    public void synthesizeStream(String text, float speed, PcmSink sink) {
        if (sink == null) throw new IllegalArgumentException("Expected PCM sink");
        if (closing) throw new IllegalStateException("Paradee voice closing");
        final long admitted = generation.get();
        synchronized (this) {
            final long ctx = check();
            if (closing || generation.get() != admitted) throw new CancellationException();
            if (!supportsStreaming()) throw new IllegalStateException("Paradee streaming unavailable");
            streaming = true;
            streamingThread = Thread.currentThread();
            try {
                PcmSink guarded = new NativeSink(admitted, sink);
                if (closing || generation.get() != admitted) throw new CancellationException();
                if (voiceId == null) VoiceNative.nativeParadeeSynthesizeStream(ctx, bytes(text), speed, guarded);
                else VoiceNative.nativeParadeeSynthesizeVoiceStream(ctx, voiceId, bytes(text), speed, guarded);
                if (closing || generation.get() != admitted) throw new CancellationException();
            } finally {
                streaming = false;
                streamingThread = null;
            }
        }
    }

    /**
     * Stops the running synthesis and every call waiting for it, if any. Safe from any thread.
     * It is not aimed at one call; to cancel one non-streaming call and no other, give it a
     * {@link Request}.
     */
    public void cancel() {
        generation.incrementAndGet();
        synchronized (handleLock) {
            if (handle != 0) VoiceNative.nativeCancelTts(handle);
        }
    }

    /** Frees the model weights and keeps the instance; the next call reloads them. */
    public synchronized void trimMemory() {
        VoiceNative.nativeMmapEvict(check(), "tts");
    }

    @Override
    public void close() {
        if (streamingThread == Thread.currentThread()) throw new IllegalStateException("Cannot close voice from PCM callback");
        closing = true;
        cancel();
        synchronized (this) {
            if (streaming) throw new IllegalStateException("Cannot close voice from PCM callback");
            synchronized (handleLock) {
                if (handle != 0) {
                    if (ownsContext) VoiceNative.nativeContextDestroy(handle);
                    else if (voiceId != null) VoiceNative.nativeParadeeUnloadVoice(handle, voiceId);
                    handle = 0;
                }
            }
        }
    }

    private long check() {
        if (closing) throw new IllegalStateException("Paradee voice closing");
        if (streaming) throw new IllegalStateException("Cannot reenter voice from PCM callback");
        synchronized (handleLock) {
            if (handle == 0) throw new IllegalStateException("Paradee voice closed");
            return handle;
        }
    }

    private static byte[] bytes(String value) {
        if (value == null) throw new IllegalArgumentException("Expected text");
        return value.getBytes(StandardCharsets.UTF_8);
    }
}
