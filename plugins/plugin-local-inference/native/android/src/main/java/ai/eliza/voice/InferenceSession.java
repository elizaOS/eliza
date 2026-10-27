package ai.eliza.voice;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.ArrayList;
import java.util.List;

/**
 * One owner for a consumer's fused text, embedding, speech and ASR context.
 * Calls run on the consumer's worker. Trim releases all native model memory;
 * the next call loads it again. Close is terminal. No model is loaded by the
 * constructor. A voice bundle can serve speech without a text model.
 *
 * <p>Voice activity detection ({@link #openVad}) has its own small native
 * context and lock under the same owner: microphone capture keeps running while
 * a synthesis stream holds the speech lock (full duplex), and output
 * cancellation never fences input.
 */
public final class InferenceSession implements AutoCloseable {
    private final File bundleDir;
    private final File voiceModel;
    private final File lexicon;
    private final File espeakDir;
    private final AtomicLong generation = new AtomicLong();
    private volatile ParadeeVoice voice;
    private volatile NativeAsr asr;
    private volatile boolean closed;
    private volatile Thread streamingThread;
    private long context;
    private final List<TextStream> textStreams = new ArrayList<>();
    private final Object vadLock = new Object();
    private long vadContext; // Guarded by vadLock.
    private final List<Vad> vads = new ArrayList<>(); // Guarded by vadLock.

    public InferenceSession(File bundleDir) throws IOException {
        this(bundleDir, new File(bundleDir, "tts/paradee/paradee-8m-v1_1.gguf"),
                new File(bundleDir, "tts/paradee/misaki-en-us.lex"),
                new File(bundleDir, "tts/paradee/espeak-ng-data").isDirectory()
                        ? new File(bundleDir, "tts/paradee") : null);
    }

    InferenceSession(File bundleDir, File voiceModel, File lexicon, File espeakDir) throws IOException {
        this.bundleDir = bundleDir.getCanonicalFile();
        if (!this.bundleDir.isDirectory()) throw new IOException("Missing inference bundle");
        this.voiceModel = voiceModel;
        this.lexicon = lexicon;
        this.espeakDir = espeakDir;
    }

    private long acquire(long admitted) {
        if (streamingThread == Thread.currentThread()) throw new IllegalStateException("Cannot reenter inference from PCM callback");
        if (closed) throw new IllegalStateException("Inference session closed");
        if (generation.get() != admitted) throw new CancellationException();
        if (context == 0L) {
            context = VoiceNative.nativeContextCreate(bundleDir.getAbsolutePath());
            if (context == 0L) throw new IllegalStateException("Inference context creation failed");
        }
        return context;
    }

    private ParadeeVoice voice(long admitted) throws IOException {
        long ctx = acquire(admitted);
        if (voice == null) voice = new ParadeeVoice(voiceModel, lexicon, espeakDir, ctx);
        if (generation.get() != admitted) throw new CancellationException();
        return voice;
    }

    private NativeAsr asr(long admitted) throws IOException {
        long ctx = acquire(admitted);
        if (asr == null) asr = new NativeAsr(bundleDir, ctx);
        if (generation.get() != admitted) throw new CancellationException();
        return asr;
    }

    /** True once {@link #close} began; a closed session never reopens. */
    public boolean isClosed() {
        return closed;
    }

    /** Native Silero VAD is compiled in. Loads the library; opens no context or model. */
    public boolean vadSupported() {
        if (closed) throw new IllegalStateException("Inference session closed");
        return VoiceNative.nativeVadSupported() == 1;
    }

    /**
     * Opens one Silero VAD detector (16 kHz mono, one probability per 512-sample
     * window) from the bundle's {@code vad/} model. It never waits for the speech
     * lock and is not fenced by {@link #cancel}. {@link #trimMemory} keeps open
     * detectors; {@link #close} retires them, after which they throw.
     */
    public Vad openVad() {
        synchronized (vadLock) {
            if (closed) throw new IllegalStateException("Inference session closed");
            if (VoiceNative.nativeVadSupported() != 1) throw new IllegalStateException("VAD unavailable");
            if (vadContext == 0L) {
                vadContext = VoiceNative.nativeContextCreate(bundleDir.getAbsolutePath());
                if (vadContext == 0L) throw new IllegalStateException("VAD context creation failed");
            }
            long handle = VoiceNative.nativeVadOpen(vadContext);
            if (handle == 0L) throw new IllegalStateException("VAD unavailable");
            Vad vad = new Vad(handle);
            vads.add(vad);
            return vad;
        }
    }

    /** Samples in one VAD window at 16 kHz (32 ms). */
    public static final int VAD_WINDOW = 512;

    /** One detector. Calls are serialized on the detector; close may come from any thread. */
    public final class Vad implements AutoCloseable {
        private long handle; // Guarded by this.
        private Vad(long handle) { this.handle = handle; }

        /** One speech probability per complete {@link #VAD_WINDOW}-sample window. */
        public synchronized float[] process(float[] pcm16kMono) {
            if (handle == 0L) throw new IllegalStateException("VAD closed");
            if (pcm16kMono == null || pcm16kMono.length == 0 || pcm16kMono.length % VAD_WINDOW != 0) {
                throw new IllegalArgumentException("Expected complete 512-sample windows");
            }
            return VoiceNative.nativeVadProcessBatch(handle, pcm16kMono);
        }

        /** Clears the recurrent state at an utterance boundary. */
        public synchronized void reset() {
            if (handle == 0L) throw new IllegalStateException("VAD closed");
            VoiceNative.nativeVadReset(handle);
        }

        /** Idempotent. Waits for a window in progress. */
        @Override
        public void close() {
            synchronized (this) {
                if (handle == 0L) return;
                VoiceNative.nativeVadClose(handle);
                handle = 0L;
            }
            retire(this);
        }
    }

    private void retire(Vad vad) {
        synchronized (vadLock) {
            vads.remove(vad);
            if (closed && vads.isEmpty()) releaseVadContext();
        }
    }

    /** Caller holds vadLock; only when no detector remains open. */
    private void releaseVadContext() {
        if (vadContext != 0L && vads.isEmpty()) {
            VoiceNative.nativeContextDestroy(vadContext);
            vadContext = 0L;
        }
    }

    /** Query engine support without opening a context or loading voice weights. */
    public boolean supportsStreaming() {
        if (closed) throw new IllegalStateException("Inference session closed");
        return VoiceNative.nativeParadeeStreamSupported() == 1;
    }

    /** Explicitly prepare speech output and recognition for a readiness check. */
    public void prepareSpeech() throws IOException {
        long admitted = generation.get();
        synchronized (this) {
            voice(admitted);
            asr(admitted);
            checkGeneration(admitted);
        }
    }

    /** Observe loaded speech output without creating a context or loading models. */
    public boolean isSpeechLoaded() {
        return !closed && voice != null;
    }

    /** Load only speech output, if needed, and return its actual sample rate. */
    public int speechSampleRate() throws IOException {
        long admitted = generation.get();
        synchronized (this) {
            int sampleRate = voice(admitted).sampleRate();
            checkGeneration(admitted);
            return sampleRate;
        }
    }

    public ParadeeVoice.Audio synthesize(String text, float speed) throws IOException {
        long admitted = generation.get();
        synchronized (this) {
            ParadeeVoice.Audio result = voice(admitted).synthesize(text, speed);
            checkGeneration(admitted);
            return result;
        }
    }

    public void synthesizeStream(String text, float speed, ParadeeVoice.PcmSink sink) throws IOException {
        long admitted = generation.get();
        synchronized (this) {
            ParadeeVoice backend = voice(admitted);
            streamingThread = Thread.currentThread();
            try {
                backend.synthesizeStream(text, speed, sink);
                checkGeneration(admitted);
            } finally {
                streamingThread = null;
            }
        }
    }

    public String transcribe(float[] pcm16kMono) throws IOException {
        long admitted = generation.get();
        synchronized (this) {
            String text = asr(admitted).transcribe(pcm16kMono);
            checkGeneration(admitted);
            return text;
        }
    }

    public NativeAsr.Stream openTranscriptionStream(int sampleRate) throws IOException {
        long admitted = generation.get();
        synchronized (this) {
            return asr(admitted).openStream(sampleRate);
        }
    }

    /** The bundle must contain a text model supported by libelizainference. */
    public TextStream openTextStream(String prompt, int maxTokens) {
        if (prompt == null || maxTokens <= 0) throw new IllegalArgumentException("Expected prompt and positive maxTokens");
        long admitted = generation.get();
        synchronized (this) {
            long ctx = acquire(admitted);
            long stream = VoiceNative.nativeLlmStreamOpen(ctx, maxTokens, 0f, 1f, 1, -1, "");
            if (stream == 0L) throw new IllegalStateException("Text stream creation failed");
            try {
                int[] tokens = VoiceNative.nativeTokenizeUtf8(ctx, prompt.getBytes(StandardCharsets.UTF_8));
                VoiceNative.nativeLlmStreamPrefill(stream, tokens);
                checkGeneration(admitted);
                TextStream result = new TextStream(stream, admitted);
                textStreams.add(result);
                return result;
            } catch (RuntimeException failure) {
                VoiceNative.nativeLlmStreamClose(stream);
                throw failure;
            }
        }
    }

    /** Native JSON decode steps ({text, done, nout}); close after the final step. */
    public final class TextStream implements AutoCloseable {
        private long handle;
        private final long admitted;
        private TextStream(long handle, long admitted) { this.handle = handle; this.admitted = admitted; }
        public String next() {
            synchronized (InferenceSession.this) {
                if (handle == 0L) throw new IllegalStateException("Text stream closed");
                checkGeneration(admitted);
                String result = VoiceNative.nativeLlmStreamNext(handle, 1);
                checkGeneration(admitted);
                return result;
            }
        }
        @Override public void close() {
            synchronized (InferenceSession.this) {
                if (handle != 0L) { VoiceNative.nativeLlmStreamClose(handle); handle = 0L; }
                textStreams.remove(this);
            }
        }
    }

    /** No text truncation or implicit added-token parsing. */
    public float[] embed(String text, int pooling) {
        if (text == null) throw new IllegalArgumentException("Expected text");
        long admitted = generation.get();
        synchronized (this) {
            float[] result = VoiceNative.nativeEmbedWithOptionsUtf8(
                    acquire(admitted), text.getBytes(StandardCharsets.UTF_8), pooling, false);
            checkGeneration(admitted);
            return result;
        }
    }

    private void checkGeneration(long admitted) {
        if (generation.get() != admitted) throw new CancellationException();
    }

    /** Interrupt speech/ASR natively and text at its next decode step. */
    public void cancel() {
        generation.incrementAndGet();
        ParadeeVoice currentVoice = voice;
        NativeAsr currentAsr = asr;
        if (currentVoice != null) currentVoice.cancel();
        if (currentAsr != null) currentAsr.cancel();
    }

    /**
     * Wait for active calls and streams to retire, then free the shared context.
     * Open VAD detectors stay usable; an idle VAD context is freed too.
     */
    public void trimMemory() {
        if (streamingThread == Thread.currentThread()) throw new IllegalStateException("Cannot trim inference from PCM callback");
        cancel();
        synchronized (this) {
            release();
        }
        synchronized (vadLock) {
            releaseVadContext();
        }
    }

    private void release() {
        for (TextStream stream : new ArrayList<>(textStreams)) stream.close();
        if (voice != null) { voice.close(); voice = null; }
        if (asr != null) { asr.close(); asr = null; }
        if (context != 0L) {
            VoiceNative.nativeContextDestroy(context);
            context = 0L;
        }
    }

    @Override
    public void close() {
        if (streamingThread == Thread.currentThread()) throw new IllegalStateException("Cannot close inference from PCM callback");
        closed = true;
        trimMemory();
        List<Vad> open;
        synchronized (vadLock) {
            open = new ArrayList<>(vads);
        }
        for (Vad vad : open) vad.close();
        synchronized (vadLock) {
            releaseVadContext();
        }
    }
}
