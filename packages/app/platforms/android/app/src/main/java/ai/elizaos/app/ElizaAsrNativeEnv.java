/** ASR backend and thread settings handed to libelizainference before it loads. */
package ai.elizaos.app;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * libelizainference reads {@code ELIZA_ASR_BACKEND} and {@code ELIZA_ASR_THREADS}
 * from the process environment when it loads the ASR region. Phonon-2 on the
 * Parakeet-TDT model is the only ASR. It uses the registered in-tree
 * {@code ggml} backend; {@code parakeet} is not a backend registry name.
 * The staged bundle verifies the Phonon-2 model. In the app process nothing sets
 * them, so {@link ElizaVoiceNative#ensureLoaded} calls {@link #apply} before
 * {@code System.loadLibrary}.
 *
 * <p>Threads: an existing process variable wins; otherwise the build-time value
 * ({@code BuildConfig.ELIZA_ASR_THREADS}); otherwise one thread per big core.
 *
 * <p>A big core is one whose {@code cpuinfo_max_freq} is within 20% of the
 * fastest core, the same rule the parakeet pool uses to pin workers.
 */
final class ElizaAsrNativeEnv {

    interface EnvWriter {
        void set(String key, String value) throws Exception;
    }

    private ElizaAsrNativeEnv() {}

    /** Phonon-2 runs on the in-tree ggml backend. */
    static final String BACKEND = "ggml";

    /** Positive thread count, or 0 when unset/invalid. */
    static int parseThreads(String value) {
        if (value == null) return 0;
        try {
            final int n = Integer.parseInt(value.trim());
            return n > 0 && n <= 64 ? n : 0;
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /**
     * Cores whose max frequency is within 20% of the fastest. Unknown
     * frequencies (<= 0) are ignored; with none known, half the cores.
     */
    static int bigCoreCount(long[] maxFreqKhz, int availableProcessors) {
        long fastest = 0;
        for (long f : maxFreqKhz) fastest = Math.max(fastest, f);
        if (fastest <= 0) return Math.max(1, availableProcessors / 2);
        int n = 0;
        for (long f : maxFreqKhz) {
            if (f > 0 && f * 5 >= fastest * 4) n++;
        }
        return Math.max(1, n);
    }

    static long[] readMaxFreqs(File cpuRoot, int cpus) {
        final long[] out = new long[Math.max(0, cpus)];
        for (int i = 0; i < out.length; i++) {
            final File f = new File(cpuRoot, "cpu" + i + "/cpufreq/cpuinfo_max_freq");
            try {
                out[i] = Long.parseLong(new String(Files.readAllBytes(f.toPath()),
                    StandardCharsets.US_ASCII).trim());
            } catch (Exception unreadable) {
                out[i] = 0;
            }
        }
        return out;
    }

    /** The thread count to export: process value, else build value, else big cores. */
    static int resolveThreads(String processValue, String buildValue, int bigCores) {
        final int p = parseThreads(processValue);
        if (p > 0) return p;
        final int b = parseThreads(buildValue);
        return b > 0 ? b : Math.max(1, bigCores);
    }

    /** Set both variables; fail before loading a library with the wrong backend. */
    static String apply(String buildThreads, EnvWriter env) {
        final int cpus = Runtime.getRuntime().availableProcessors();
        final int bigCores = bigCoreCount(
            readMaxFreqs(new File("/sys/devices/system/cpu"), cpus), cpus);
        final String backend = BACKEND;
        final int threads = resolveThreads(System.getenv("ELIZA_ASR_THREADS"), buildThreads, bigCores);
        try {
            env.set("ELIZA_ASR_BACKEND", backend);
            env.set("ELIZA_ASR_THREADS", String.valueOf(threads));
        } catch (Exception e) {
            throw new IllegalStateException("Cannot configure the Phonon-2 ASR backend", e);
        }
        return backend + "/" + threads;
    }
}
