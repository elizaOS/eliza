package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public final class ElizaAsrNativeEnvTest {

    @Test
    public void bigCoresAreWithinTwentyPercentOfTheFastest() {
        // Tensor G4 shape: 1 x 3.1 GHz, 3 x 2.6 GHz, 4 x 1.92 GHz.
        final long[] g4 = {1920000, 1920000, 1920000, 1920000, 2600000, 2600000, 2600000, 3100000};
        assertEquals(4, ElizaAsrNativeEnv.bigCoreCount(g4, 8));
        // 2 big + 6 little.
        assertEquals(2, ElizaAsrNativeEnv.bigCoreCount(new long[] {1800000, 1800000, 1800000, 1800000, 1800000, 1800000, 2400000, 2400000}, 8));
        // Symmetric SoC: every core is big.
        assertEquals(4, ElizaAsrNativeEnv.bigCoreCount(new long[] {2000000, 2000000, 2000000, 2000000}, 4));
        // Unreadable sysfs: half the cores, at least one.
        assertEquals(4, ElizaAsrNativeEnv.bigCoreCount(new long[] {0, 0, 0, 0, 0, 0, 0, 0}, 8));
        assertEquals(1, ElizaAsrNativeEnv.bigCoreCount(new long[0], 1));
    }

    @Test
    public void backendResolution() {
        assertEquals("parakeet", ElizaAsrNativeEnv.normalizeBackend(" Parakeet "));
        assertEquals("qwen3", ElizaAsrNativeEnv.normalizeBackend("mtmd"));
        assertEquals("auto", ElizaAsrNativeEnv.normalizeBackend(""));
        assertNull(ElizaAsrNativeEnv.normalizeBackend("whisper"));
        assertEquals("qwen3", ElizaAsrNativeEnv.resolveBackend("qwen3", "parakeet"));
        assertEquals("parakeet", ElizaAsrNativeEnv.resolveBackend(null, "parakeet"));
        assertEquals("parakeet", ElizaAsrNativeEnv.resolveBackend("bogus", "parakeet"));
        assertEquals("auto", ElizaAsrNativeEnv.resolveBackend(null, null));
    }

    @Test
    public void threadResolution() {
        assertEquals(3, ElizaAsrNativeEnv.resolveThreads("3", "6", 4));
        assertEquals(6, ElizaAsrNativeEnv.resolveThreads(null, "6", 4));
        assertEquals(4, ElizaAsrNativeEnv.resolveThreads("0", "", 4));
        assertEquals(4, ElizaAsrNativeEnv.resolveThreads("x", "-2", 4));
        assertEquals(1, ElizaAsrNativeEnv.resolveThreads(null, null, 0));
    }

    @Test
    public void applyWritesBothVariables() {
        final Map<String, String> env = new HashMap<>();
        final String summary = ElizaAsrNativeEnv.apply("parakeet", "2", env::put);
        final String processBackend = System.getenv("ELIZA_ASR_BACKEND");
        if (processBackend == null) {
            assertEquals("parakeet", env.get("ELIZA_ASR_BACKEND"));
        }
        if (System.getenv("ELIZA_ASR_THREADS") == null) {
            assertEquals("2", env.get("ELIZA_ASR_THREADS"));
        }
        assertTrue(summary.contains("/"));
    }
}
