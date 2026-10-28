package ai.eliza.voice;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * On-device English transcription with the ASR head of
 * {@code libelizainference}. {@code <bundleDir>/asr/} holds Phonon-2
 * ({@code phonon-2-fv5.gguf}, Parakeet-TDT; batch and streaming), the only
 * ASR model. Batch input is 16 kHz mono float PCM;
 * streams take any rate. No agent, server, account or network use.
 *
 * <p>Calls are serialized; run them on a worker thread. {@link #cancel} may
 * be called from any thread and makes the running call throw
 * {@link java.util.concurrent.CancellationException}.
 */
public final class NativeAsr implements AutoCloseable {
    public static final int SAMPLE_RATE = 16000;

    private final Object handleLock = new Object();
    private final List<Stream> streams = new ArrayList<>();
    private long handle;
    private final boolean ownsContext;

    /** Loads the ASR weights from {@code bundleDir/asr}. */
    public NativeAsr(File bundleDir) throws IOException {
        this(bundleDir, 0L);
    }

    NativeAsr(File bundleDir, long sharedContext) throws IOException {
        ownsContext = sharedContext == 0L;
        if (!new File(bundleDir, "asr").isDirectory()) {
            throw new IOException("Missing ASR model directory " + new File(bundleDir, "asr"));
        }
        if (VoiceNative.nativeAsrSupported() != 1) {
            throw new IllegalStateException("libelizainference was built without ASR");
        }
        long ctx = ownsContext ? VoiceNative.nativeContextCreate(bundleDir.getAbsolutePath()) : sharedContext;
        try {
            VoiceNative.nativeMmapAcquire(ctx, "asr");
        } catch (RuntimeException error) {
            if (ownsContext) VoiceNative.nativeContextDestroy(ctx);
            throw new IOException("ASR model load failed", error);
        }
        handle = ctx;
    }

    /** Transcribes 16 kHz mono PCM in [-1, 1]. */
    public synchronized String transcribe(float[] pcm16kMono) {
        if (pcm16kMono == null || pcm16kMono.length == 0) throw new IllegalArgumentException("Expected audio");
        return VoiceNative.nativeAsrTranscribe(check(), pcm16kMono, SAMPLE_RATE);
    }

    /** True when the loaded backend streams (Phonon-2); false only for a library built without Parakeet-TDT. */
    public boolean supportsStreaming() {
        check();
        return VoiceNative.nativeAsrStreamSupported() == 1;
    }

    /**
     * Opens a streaming session for mono PCM at {@code sampleRate} Hz. Throws
     * {@link IllegalArgumentException} when the bundle's ASR backend cannot
     * stream; use {@link #transcribe} then.
     */
    public synchronized Stream openStream(int sampleRate) {
        long stream = VoiceNative.nativeAsrStreamOpen(check(), sampleRate);
        Stream out = new Stream(stream);
        synchronized (handleLock) {
            streams.add(out);
        }
        return out;
    }

    /** Stops the running transcription, if any. Safe from any thread. */
    public void cancel() {
        synchronized (handleLock) {
            if (handle != 0) VoiceNative.nativeAsrCancel(handle);
        }
    }

    /** Frees the ASR weights and keeps the instance; the next call reloads them. Open streams then fail. */
    public synchronized void trimMemory() {
        VoiceNative.nativeMmapEvict(check(), "asr");
    }

    @Override
    public void close() {
        cancel();
        synchronized (this) {
            List<Stream> open;
            synchronized (handleLock) {
                open = new ArrayList<>(streams);
            }
            for (Stream stream : open) stream.close();
            synchronized (handleLock) {
                if (handle != 0) {
                    if (ownsContext) VoiceNative.nativeContextDestroy(handle);
                    handle = 0;
                }
            }
        }
    }

    private long check() {
        synchronized (handleLock) {
            if (handle == 0) throw new IllegalStateException("ASR closed");
            return handle;
        }
    }

    /**
     * One streaming session: {@link #feed} audio as it arrives (it only
     * buffers, so the audio thread may call it), read {@link #partial} from a
     * worker, then {@link #finish} and {@link #close}. Partial and finish are
     * serialized with each other and with close.
     */
    public final class Stream implements AutoCloseable {
        private final Object feedLock = new Object();
        private long stream;

        private Stream(long stream) {
            this.stream = stream;
        }

        /** Buffers mono PCM in [-1, 1] at the stream's rate. */
        public void feed(float[] pcm) {
            synchronized (feedLock) {
                if (stream == 0) throw new IllegalStateException("ASR stream closed");
                VoiceNative.nativeAsrStreamFeed(stream, pcm);
            }
        }

        /** Decodes the audio fed so far and returns the running transcript. */
        public synchronized String partial() {
            return VoiceNative.nativeAsrStreamPartial(live());
        }

        /** Final transcript; later feeds throw. */
        public synchronized String finish() {
            return VoiceNative.nativeAsrStreamFinish(live());
        }

        /** Stops a partial or finish running on another thread. */
        public void cancel() {
            // Under feedLock so close cannot free the handle mid-call; the
            // native cancel only sets a flag.
            synchronized (feedLock) {
                if (stream != 0) VoiceNative.nativeAsrStreamCancel(stream);
            }
        }

        @Override
        public void close() {
            cancel();
            synchronized (this) {
                synchronized (feedLock) {
                    if (stream != 0) {
                        VoiceNative.nativeAsrStreamClose(stream);
                        stream = 0;
                    }
                }
            }
            synchronized (handleLock) {
                streams.remove(this);
            }
        }

        private long live() {
            synchronized (feedLock) {
                if (stream == 0) throw new IllegalStateException("ASR stream closed");
                return stream;
            }
        }
    }
}
