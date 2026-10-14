package ai.eliza.voice;

import java.io.File;
import java.io.IOException;

/**
 * On-device English transcription with the ASR head of
 * {@code libelizainference}: a GGUF audio-LLM pair under
 * {@code <bundleDir>/asr/} (text model plus mmproj). Input is 16 kHz mono
 * float PCM. No agent, server, account or network use.
 *
 * <p>Calls are serialized; run them on a worker thread. {@link #cancel} may
 * be called from any thread and makes the running call throw
 * {@link java.util.concurrent.CancellationException}.
 */
public final class NativeAsr implements AutoCloseable {
    public static final int SAMPLE_RATE = 16000;

    private final Object handleLock = new Object();
    private long handle;

    /** Loads the ASR weights from {@code bundleDir/asr}. */
    public NativeAsr(File bundleDir) throws IOException {
        if (!new File(bundleDir, "asr").isDirectory()) {
            throw new IOException("Missing ASR model directory " + new File(bundleDir, "asr"));
        }
        if (VoiceNative.nativeAsrSupported() != 1) {
            throw new IllegalStateException("libelizainference was built without ASR");
        }
        long ctx = VoiceNative.nativeContextCreate(bundleDir.getAbsolutePath());
        try {
            VoiceNative.nativeMmapAcquire(ctx, "asr");
        } catch (RuntimeException error) {
            VoiceNative.nativeContextDestroy(ctx);
            throw new IOException("ASR model load failed", error);
        }
        handle = ctx;
    }

    /** Transcribes 16 kHz mono PCM in [-1, 1]. */
    public synchronized String transcribe(float[] pcm16kMono) {
        if (pcm16kMono == null || pcm16kMono.length == 0) throw new IllegalArgumentException("Expected audio");
        return VoiceNative.nativeAsrTranscribe(check(), pcm16kMono, SAMPLE_RATE);
    }

    /** Stops the running transcription, if any. Safe from any thread. */
    public void cancel() {
        synchronized (handleLock) {
            if (handle != 0) VoiceNative.nativeAsrCancel(handle);
        }
    }

    /** Frees the ASR weights and keeps the instance; the next call reloads them. */
    public synchronized void trimMemory() {
        VoiceNative.nativeMmapEvict(check(), "asr");
    }

    @Override
    public void close() {
        cancel();
        synchronized (this) {
            synchronized (handleLock) {
                if (handle != 0) {
                    VoiceNative.nativeContextDestroy(handle);
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
}
