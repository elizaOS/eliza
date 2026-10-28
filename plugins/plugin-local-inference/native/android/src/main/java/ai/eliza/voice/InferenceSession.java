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
 * <p>Independent consumers that share one session (the process-wide
 * {@link VoiceAssets#sharedInference}) each use their own {@link #client}. Their
 * calls still serialize on the session, but a client's {@link Client#cancel}
 * fences only that client's calls, and its {@link Client#release} frees the
 * models only once no other client holds them. The session's own
 * {@link #cancel}, {@link #trimMemory} and {@link #close} act on every caller.
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
    private final Object runningLock = new Object();
    private Client running; // Guarded by runningLock: the client whose call holds this session.
    private final Object clientsLock = new Object();
    private int holders; // Guarded by clientsLock: clients holding the models since their last release.

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

    /**
     * A call's admission, taken before it waits for this session: the session
     * generation and, for a client's call, that client's own.
     */
    private final class Admission {
        final Client client;
        final long scoped;
        final long session;

        Admission(Client client) {
            this.client = client;
            this.scoped = client == null ? 0L : client.epoch.get();
            this.session = generation.get();
        }

        boolean current() {
            return generation.get() == session && (client == null || client.epoch.get() == scoped);
        }
    }

    /**
     * Caller holds this session's lock. Marks the running client, so only its own
     * cancel interrupts the native call, and its hold on the models while it is
     * still admitted.
     */
    private void begin(Admission admitted) {
        // A PCM callback reentering on the stream's own thread must not replace the running marker.
        if (streamingThread == Thread.currentThread()) throw new IllegalStateException("Cannot reenter inference from PCM callback");
        Client client = admitted.client;
        if (client != null) {
            synchronized (clientsLock) {
                if (!client.holding && admitted.current()) {
                    client.holding = true;
                    holders++;
                }
            }
        }
        synchronized (runningLock) {
            running = client;
        }
    }

    private void end() {
        synchronized (runningLock) {
            running = null;
        }
    }

    private long acquire(Admission admitted) {
        if (streamingThread == Thread.currentThread()) throw new IllegalStateException("Cannot reenter inference from PCM callback");
        if (closed) throw new IllegalStateException("Inference session closed");
        if (!admitted.current()) throw new CancellationException();
        if (context == 0L) {
            context = VoiceNative.nativeContextCreate(bundleDir.getAbsolutePath());
            if (context == 0L) throw new IllegalStateException("Inference context creation failed");
        }
        return context;
    }

    private ParadeeVoice voice(Admission admitted) throws IOException {
        long ctx = acquire(admitted);
        if (voice == null) voice = new ParadeeVoice(voiceModel, lexicon, espeakDir, ctx);
        checkGeneration(admitted);
        return voice;
    }

    private NativeAsr asr(Admission admitted) throws IOException {
        long ctx = acquire(admitted);
        if (asr == null) asr = new NativeAsr(bundleDir, ctx);
        checkGeneration(admitted);
        return asr;
    }

    /**
     * A new consumer of this session. Use one per independent owner of speech or
     * inference work; a closed session refuses new clients.
     */
    public Client client() {
        if (closed) throw new IllegalStateException("Inference session closed");
        return new Client();
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
        prepareSpeech(new Admission(null));
    }

    private void prepareSpeech(Admission admitted) throws IOException {
        synchronized (this) {
            begin(admitted);
            try {
                voice(admitted);
                asr(admitted);
                checkGeneration(admitted);
            } finally {
                end();
            }
        }
    }

    /** Observe loaded speech output without creating a context or loading models. */
    public boolean isSpeechLoaded() {
        return !closed && voice != null;
    }

    /** Load only speech output, if needed, and return its actual sample rate. */
    public int speechSampleRate() throws IOException {
        return speechSampleRate(new Admission(null));
    }

    private int speechSampleRate(Admission admitted) throws IOException {
        synchronized (this) {
            begin(admitted);
            try {
                int sampleRate = voice(admitted).sampleRate();
                checkGeneration(admitted);
                return sampleRate;
            } finally {
                end();
            }
        }
    }

    public ParadeeVoice.Audio synthesize(String text, float speed) throws IOException {
        return synthesize(new Admission(null), text, speed);
    }

    private ParadeeVoice.Audio synthesize(Admission admitted, String text, float speed) throws IOException {
        synchronized (this) {
            begin(admitted);
            try {
                ParadeeVoice.Audio result = voice(admitted).synthesize(text, speed);
                checkGeneration(admitted);
                return result;
            } finally {
                end();
            }
        }
    }

    public void synthesizeStream(String text, float speed, ParadeeVoice.PcmSink sink) throws IOException {
        synthesizeStream(new Admission(null), text, speed, sink);
    }

    private void synthesizeStream(Admission admitted, String text, float speed, ParadeeVoice.PcmSink sink) throws IOException {
        synchronized (this) {
            begin(admitted);
            try {
                ParadeeVoice backend = voice(admitted);
                streamingThread = Thread.currentThread();
                try {
                    backend.synthesizeStream(text, speed, sink);
                    checkGeneration(admitted);
                } finally {
                    streamingThread = null;
                }
            } finally {
                end();
            }
        }
    }

    public String transcribe(float[] pcm16kMono) throws IOException {
        return transcribe(new Admission(null), pcm16kMono);
    }

    private String transcribe(Admission admitted, float[] pcm16kMono) throws IOException {
        synchronized (this) {
            begin(admitted);
            try {
                String text = asr(admitted).transcribe(pcm16kMono);
                checkGeneration(admitted);
                return text;
            } finally {
                end();
            }
        }
    }

    public NativeAsr.Stream openTranscriptionStream(int sampleRate) throws IOException {
        return openTranscriptionStream(new Admission(null), sampleRate);
    }

    private NativeAsr.Stream openTranscriptionStream(Admission admitted, int sampleRate) throws IOException {
        synchronized (this) {
            begin(admitted);
            try {
                return asr(admitted).openStream(sampleRate);
            } finally {
                end();
            }
        }
    }

    /** The bundle must contain a text model supported by libelizainference. */
    public TextStream openTextStream(String prompt, int maxTokens) {
        return openTextStream(new Admission(null), prompt, maxTokens);
    }

    private TextStream openTextStream(Admission admitted, String prompt, int maxTokens) {
        if (prompt == null || maxTokens <= 0) throw new IllegalArgumentException("Expected prompt and positive maxTokens");
        synchronized (this) {
            begin(admitted);
            try {
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
            } finally {
                end();
            }
        }
    }

    /** Native JSON decode steps ({text, done, nout}); close after the final step. */
    public final class TextStream implements AutoCloseable {
        private long handle;
        private final Admission admitted;
        private TextStream(long handle, Admission admitted) { this.handle = handle; this.admitted = admitted; }
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
        return embed(new Admission(null), text, pooling);
    }

    private float[] embed(Admission admitted, String text, int pooling) {
        if (text == null) throw new IllegalArgumentException("Expected text");
        synchronized (this) {
            begin(admitted);
            try {
                float[] result = VoiceNative.nativeEmbedWithOptionsUtf8(
                        acquire(admitted), text.getBytes(StandardCharsets.UTF_8), pooling, false);
                checkGeneration(admitted);
                return result;
            } finally {
                end();
            }
        }
    }

    private void checkGeneration(Admission admitted) {
        if (!admitted.current()) throw new CancellationException();
    }

    /**
     * Interrupt every caller's speech/ASR natively and text at its next decode
     * step, clients included. A client cancels only its own calls with
     * {@link Client#cancel}.
     */
    public void cancel() {
        generation.incrementAndGet();
        ParadeeVoice currentVoice = voice;
        NativeAsr currentAsr = asr;
        if (currentVoice != null) currentVoice.cancel();
        if (currentAsr != null) currentAsr.cancel();
    }

    /**
     * Cancel every caller, wait for active calls and streams to retire, then free
     * the shared context. Open VAD detectors stay usable; an idle VAD context is
     * freed too. A client releases only its own hold with {@link Client#release}.
     */
    public void trimMemory() {
        if (streamingThread == Thread.currentThread()) throw new IllegalStateException("Cannot trim inference from PCM callback");
        cancel();
        synchronized (this) {
            freeModels();
        }
        synchronized (vadLock) {
            releaseVadContext();
        }
    }

    private void freeModels() {
        for (TextStream stream : new ArrayList<>(textStreams)) stream.close();
        if (voice != null) { voice.close(); voice = null; }
        if (asr != null) { asr.close(); asr = null; }
        if (context != 0L) {
            VoiceNative.nativeContextDestroy(context);
            context = 0L;
        }
    }

    /**
     * One consumer of a session that other consumers may share. Its calls are the
     * session's calls, serialized with every other caller. {@link #cancel} fences
     * only this client's calls (the one running and any waiting for the session)
     * and interrupts the native call only while it is this client's.
     * {@link #release} cancels this client's calls and drops its hold on the
     * models; they are freed once no client holds them, so one consumer's idle or
     * memory-pressure release never cancels or unloads another consumer's work.
     */
    public final class Client {
        private final AtomicLong epoch = new AtomicLong();
        private boolean holding; // Guarded by clientsLock.

        private Client() {}

        /** The session this client uses. */
        public InferenceSession session() { return InferenceSession.this; }

        public boolean supportsStreaming() { return InferenceSession.this.supportsStreaming(); }

        public boolean isSpeechLoaded() { return InferenceSession.this.isSpeechLoaded(); }

        public void prepareSpeech() throws IOException { InferenceSession.this.prepareSpeech(new Admission(this)); }

        public int speechSampleRate() throws IOException { return InferenceSession.this.speechSampleRate(new Admission(this)); }

        public ParadeeVoice.Audio synthesize(String text, float speed) throws IOException {
            return InferenceSession.this.synthesize(new Admission(this), text, speed);
        }

        public void synthesizeStream(String text, float speed, ParadeeVoice.PcmSink sink) throws IOException {
            InferenceSession.this.synthesizeStream(new Admission(this), text, speed, sink);
        }

        public String transcribe(float[] pcm16kMono) throws IOException {
            return InferenceSession.this.transcribe(new Admission(this), pcm16kMono);
        }

        public NativeAsr.Stream openTranscriptionStream(int sampleRate) throws IOException {
            return InferenceSession.this.openTranscriptionStream(new Admission(this), sampleRate);
        }

        public TextStream openTextStream(String prompt, int maxTokens) {
            return InferenceSession.this.openTextStream(new Admission(this), prompt, maxTokens);
        }

        public float[] embed(String text, int pooling) {
            return InferenceSession.this.embed(new Admission(this), text, pooling);
        }

        /** Fence this client's calls; safe from any thread, including a PCM callback. */
        public void cancel() {
            epoch.incrementAndGet();
            synchronized (runningLock) {
                if (running != this) return;
                ParadeeVoice currentVoice = voice;
                NativeAsr currentAsr = asr;
                if (currentVoice != null) currentVoice.cancel();
                if (currentAsr != null) currentAsr.cancel();
            }
        }

        /**
         * Cancel this client's calls and drop its hold on the models. The last
         * holder's release waits for active calls, then frees the models and an
         * idle VAD context; the next call loads them again.
         */
        public void release() {
            if (streamingThread == Thread.currentThread()) throw new IllegalStateException("Cannot release inference from PCM callback");
            cancel();
            synchronized (clientsLock) {
                if (holding) {
                    holding = false;
                    holders--;
                }
                if (holders > 0) return;
            }
            synchronized (InferenceSession.this) {
                // A client that began a call meanwhile holds the models again.
                synchronized (clientsLock) {
                    if (holders > 0) return;
                }
                freeModels();
            }
            synchronized (vadLock) {
                releaseVadContext();
            }
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
