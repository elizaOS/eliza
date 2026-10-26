package ai.eliza.voice;
import java.util.concurrent.CancellationException;
final class VoiceNative {
    static volatile int calls, destroyed, created, textClosed;
    static volatile long ttsContext, asrContext;
    static String nativeVoiceAbiVersion() { return "19"; }
    static int nativeParadeeSupported() { return 1; }
    static int nativeParadeeStreamSupported() { return 1; }
    static long nativeContextCreate(String directory) { return ++created; }
    static void nativeContextDestroy(long context) { destroyed++; }
    static int nativeParadeeLoad(long context, String model, String lexicon, String espeak) { ttsContext = context; return 0; }
    static int nativeParadeeSampleRate(long context) { return 24000; }
    static int nativeParadeeG2pKind(long context) { return 0; }
    static String nativeParadeePhonemize(long context, byte[] text) { return "test"; }
    static float[] nativeParadeeSynthesize(long context, byte[] text, float speed) { return new float[]{1}; }
    static float[] nativeParadeeSynthesizePhonemes(long context, byte[] text, float speed) { return new float[]{1}; }
    static int nativeCancelTts(long context) { return 0; }
    static int nativeMmapEvict(long context, String region) { return 0; }
    static void nativeParadeeSynthesizeStream(long context, byte[] text, float speed, Object sink) {
        calls++;
        ParadeeVoice.PcmSink output = (ParadeeVoice.PcmSink)sink;
        if (!output.onChunk(new float[]{1, 2}, false) || !output.onChunk(new float[0], true)) throw new CancellationException();
    }
    static int nativeAsrSupported() { return 1; }
    static int nativeMmapAcquire(long context, String region) { asrContext = context; return 0; }
    static String nativeAsrTranscribe(long context, float[] pcm, int rate) { asrContext = context; return "transcript"; }
    static int nativeAsrCancel(long context) { return 0; }
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
}
