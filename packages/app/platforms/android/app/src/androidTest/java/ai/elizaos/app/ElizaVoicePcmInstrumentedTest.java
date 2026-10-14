package ai.elizaos.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ElizaVoicePcmInstrumentedTest {
    @Test
    public void pcm16PreservesEveryCompleteSignedSample() {
        assertArrayEquals(new float[] {0f, -1f, 32767f / 32768f},
            ElizaVoicePlugin.decodePcm16("AAAAgP9/"), 0f);
        assertArrayEquals(new float[0], ElizaVoicePlugin.decodePcm16(""), 0f);
    }

    @Test
    public void pcm16RejectsTrailingByteInsteadOfDroppingIt() {
        assertThrows(IllegalArgumentException.class,
            () -> ElizaVoicePlugin.decodePcm16("AA=="));
        assertThrows(IllegalArgumentException.class,
            () -> ElizaVoicePlugin.decodePcm16("AAAA"));
    }

    @Test
    public void directDiarizationRejectsOversizedAudioBeforeProcessing() {
        assertTrue(ElizaVoiceNative.ensureLoaded());
        RuntimeException error = assertThrows(RuntimeException.class,
            () -> ElizaVoiceNative.nativeDiarizSegment(0, new float[80001]));
        assertTrue(error.getMessage().contains("at most 80000 samples"));
    }

    @Test
    public void nativeBatchesRejectPartialFramesBeforeProcessing() {
        assertTrue(ElizaVoiceNative.ensureLoaded());
        for (int size : new int[] {1, 511, 513, 1025}) {
            RuntimeException error = assertThrows(RuntimeException.class,
                () -> ElizaVoiceNative.nativeVadProcessBatch(0, new float[size]));
            assertTrue(error.getMessage().contains("complete 512-sample windows"));
        }
        for (int size : new int[] {1, 1279, 1281, 2561}) {
            RuntimeException error = assertThrows(RuntimeException.class,
                () -> ElizaVoiceNative.nativeWakewordScoreBatch(0, new float[size]));
            assertTrue(error.getMessage().contains("complete 1280-sample frames"));
        }
    }
    @Test
    public void bridgeRegistersParadeeAndAsrOnAbi17() {
        assertTrue(ElizaVoiceNative.ensureLoaded());
        assertTrue(Integer.parseInt(ElizaVoiceNative.nativeVoiceAbiVersion()) >= 17);
        assertEquals(1, ElizaVoiceNative.nativeParadeeSupported());
        assertEquals(1, ElizaVoiceNative.nativeAsrSupported());
    }

    @Test
    public void voiceNativesRejectAMissingContextBeforeNativeWork() {
        assertTrue(ElizaVoiceNative.ensureLoaded());
        byte[] text = "Hello.".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        java.util.List<org.junit.function.ThrowingRunnable> calls = java.util.List.of(
            () -> ElizaVoiceNative.nativeParadeeLoad(0, "a.gguf", "b.lex", null),
            () -> ElizaVoiceNative.nativeParadeePhonemize(0, text),
            () -> ElizaVoiceNative.nativeParadeeSynthesize(0, text, 1f),
            () -> ElizaVoiceNative.nativeParadeeSynthesizePhonemes(0, text, 1f),
            () -> ElizaVoiceNative.nativeCancelTts(0),
            () -> ElizaVoiceNative.nativeAsrTranscribe(0, new float[16000], 16000),
            () -> ElizaVoiceNative.nativeAsrCancel(0),
            () -> ElizaVoiceNative.nativeMmapEvict(0, "tts"));
        for (org.junit.function.ThrowingRunnable call : calls) {
            RuntimeException error = assertThrows(RuntimeException.class, call);
            assertTrue(error.getMessage(), error.getMessage().contains("rc=-2"));
        }
        assertTrue(ElizaVoiceNative.nativeParadeeSampleRate(0) < 0);
        assertTrue(ElizaVoiceNative.nativeParadeeG2pKind(0) < 0);
    }

    @Test
    public void wakewordDiagnosticsRejectEmptyOrIncompleteClipsBeforeLoadingModels() {
        assertTrue(ElizaVoiceNative.ensureLoaded());
        for (int size : new int[] {0, 1, 1279, 1281, 2561}) {
            RuntimeException positive = assertThrows(RuntimeException.class,
                () -> ElizaVoiceNative.nativeWakewordSelfTest("", new float[size], new float[1280]));
            assertTrue(positive.getMessage().contains("nonempty complete 1280-sample frames"));
            RuntimeException negative = assertThrows(RuntimeException.class,
                () -> ElizaVoiceNative.nativeWakewordSelfTest("", new float[1280], new float[size]));
            assertTrue(negative.getMessage().contains("nonempty complete 1280-sample frames"));
        }
    }

}
