package ai.eliza.voice;
import java.util.concurrent.CancellationException;
final class VoiceNative {
    static volatile int calls, destroyed, created, textClosed;
    static volatile long ttsContext, asrContext;
    static Runnable afterTtsLoad;
    static String nativeVoiceAbiVersion() { return "19"; }
    static int nativeParadeeSupported() { return 1; }
    static int nativeParadeeStreamSupported() { return 1; }
    static long nativeContextCreate(String directory) { return ++created; }
    static void nativeContextDestroy(long context) { destroyed++; }
    static int nativeParadeeLoad(long context, String model, String lexicon, String espeak) {
        ttsContext = context;
        Runnable callback = afterTtsLoad;
        afterTtsLoad = null;
        if (callback != null) callback.run();
        return 0;
    }
    static volatile int sampleRate = 24000;
    static volatile float[] synthesized = {1};
    static volatile float[][] streamed;
    static volatile String heard = "transcript";
    static int nativeParadeeSampleRate(long context) { return sampleRate; }
    static int nativeParadeeG2pKind(long context) { return 0; }
    static String nativeParadeePhonemize(long context, byte[] text) { return "test"; }
    static float[] nativeParadeeSynthesize(long context, byte[] text, float speed) { return synthesized.clone(); }
    static float[] nativeParadeeSynthesizePhonemes(long context, byte[] text, float speed) { return new float[]{1}; }
    static volatile int ttsCancels, asrCancels;
    static int nativeCancelTts(long context) { ttsCancels++; return 0; }
    static int nativeMmapEvict(long context, String region) { return 0; }
    static void nativeParadeeSynthesizeStream(long context, byte[] text, float speed, Object sink) {
        calls++;
        ParadeeVoice.PcmSink output = (ParadeeVoice.PcmSink)sink;
        float[][] chunks = streamed;
        if (chunks != null) {
            for (float[] chunk : chunks) if (!output.onChunk(chunk.clone(), false)) throw new CancellationException();
            if (!output.onChunk(new float[0], true)) throw new CancellationException();
            return;
        }
        if (!output.onChunk(new float[]{1, 2}, false) || !output.onChunk(new float[0], true)) throw new CancellationException();
    }
    static int nativeAsrSupported() { return 1; }
    static int nativeMmapAcquire(long context, String region) { asrContext = context; return 0; }
    static String nativeAsrTranscribe(long context, float[] pcm, int rate) { asrContext = context; return heard; }
    static int nativeAsrCancel(long context) { asrCancels++; return 0; }
    static int nativeAsrStreamSupported() { return 1; }
    static long nativeAsrStreamOpen(long context, int rate) { return 100; }
    static int nativeAsrStreamFeed(long stream, float[] pcm) { return pcm.length; }
    static String nativeAsrStreamPartial(long stream) { return "partial"; }
    static String nativeAsrStreamFinish(long stream) { return "final"; }
    static int nativeAsrStreamCancel(long stream) { return 0; }
    static void nativeAsrStreamClose(long stream) {}
    static long nativeLlmStreamOpen(long context, int tokens, float temperature, float topP, int topK, int gpu, String drafter) { return 200; }
    static int[] nativeTokenizeUtf8(long context, byte[] text) { return new int[]{1}; }
    static void nativeLlmStreamPrefill(long stream, int[] tokens) {}
    static String nativeLlmStreamNext(long stream, int count) { return "step"; }
    static void nativeLlmStreamClose(long stream) { textClosed++; }
    static float[] nativeEmbedWithOptionsUtf8(long context, byte[] text, int pooling, boolean special) { return new float[]{context}; }
    static volatile int vadSupported = 1, vadOpened, vadClosed, vadResets;
    static volatile long vadContext, nextVad = 1000;
    static java.util.concurrent.CountDownLatch vadEntered, vadRelease;
    static int nativeVadSupported() { return vadSupported; }
    static long nativeVadOpen(long context) { vadContext = context; vadOpened++; return ++nextVad; }
    static float[] nativeVadProcessBatch(long vad, float[] pcm) {
        java.util.concurrent.CountDownLatch entered = vadEntered, release = vadRelease;
        if (entered != null) entered.countDown();
        if (release != null) try { release.await(5, java.util.concurrent.TimeUnit.SECONDS); } catch (InterruptedException error) { throw new IllegalStateException(error); }
        float[] out = new float[pcm.length / 512];
        for (int i = 0; i < out.length; i++) out[i] = pcm[i * 512];
        return out;
    }
    static void nativeVadReset(long vad) { vadResets++; }
    static void nativeVadClose(long vad) { vadClosed++; }
}
