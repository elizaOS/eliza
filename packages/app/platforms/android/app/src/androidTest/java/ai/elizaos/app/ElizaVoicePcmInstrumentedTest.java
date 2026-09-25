package ai.elizaos.app;

import static org.junit.Assert.assertArrayEquals;
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
}
