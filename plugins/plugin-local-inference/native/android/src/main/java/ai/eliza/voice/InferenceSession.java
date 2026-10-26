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

    /** Wait for active calls and streams to retire, then free the shared context. */
    public void trimMemory() {
        if (streamingThread == Thread.currentThread()) throw new IllegalStateException("Cannot trim inference from PCM callback");
        cancel();
        synchronized (this) {
            release();
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
    }
}
