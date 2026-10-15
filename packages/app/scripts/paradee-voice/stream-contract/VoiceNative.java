package ai.eliza.voice;
import java.util.concurrent.CancellationException;
final class VoiceNative {
    static volatile int calls, destroyed;
    static String nativeVoiceAbiVersion() { return "19"; }
    static int nativeParadeeSupported() { return 1; }
    static int nativeParadeeStreamSupported() { return 1; }
    static long nativeContextCreate(String directory) { return 1; }
    static void nativeContextDestroy(long context) { destroyed++; }
    static int nativeParadeeLoad(long context, String model, String lexicon, String espeak) { return 0; }
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
}
