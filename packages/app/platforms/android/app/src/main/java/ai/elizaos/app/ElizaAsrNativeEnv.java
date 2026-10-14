/** ASR backend and thread settings handed to libelizainference before it loads. */
package ai.elizaos.app;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Locale;

/**
 * libelizainference reads {@code ELIZA_ASR_BACKEND} ({@code parakeet} for
 * Phonon-2, {@code qwen3} for the Qwen3-ASR pair, unset or {@code auto} to
 * pick from the bundle) and {@code ELIZA_ASR_THREADS} from the process
 * environment when it loads the ASR region. In the app process nothing sets
 * them, so {@link ElizaVoiceNative#ensureLoaded} calls {@link #apply} before
 * {@code System.loadLibrary}.
 *
 * <p>Values: an existing process variable wins; otherwise the build-time value
 * ({@code BuildConfig}, from the same {@code ELIZA_ASR_BACKEND} /
 * {@code ELIZA_ASR_THREADS} that choose which model the build stages);
 * otherwise backend {@code auto} and one thread per big core.
 *
 * <p>A big core is one whose {@code cpuinfo_max_freq} is within 20% of the
 * fastest core, the same rule the parakeet pool uses to pin workers.
 */
final class ElizaAsrNativeEnv {

    interface EnvWriter {
        void set(String key, String value) throws Exception;
    }

    private ElizaAsrNativeEnv() {}

    /** Normalise a backend name; null when it is not one the library knows. */
    static String normalizeBackend(String value) {
        if (value == null) return null;
        final String v = value.trim().toLowerCase(Locale.ROOT);
        switch (v) {
            case "":
            case "auto":
                return "auto";
            case "parakeet":
                return "parakeet";
            case "qwen3":
            case "mtmd":
                return "qwen3";
            default:
                return null;
        }
    }

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

    /** The backend to export: process value, else build value, else auto. */
    static String resolveBackend(String processValue, String buildValue) {
        final String fromProcess = normalizeBackend(processValue);
        if (processValue != null && fromProcess != null) return fromProcess;
        final String fromBuild = normalizeBackend(buildValue);
        return fromBuild != null ? fromBuild : "auto";
    }

    /** The thread count to export: process value, else build value, else big cores. */
    static int resolveThreads(String processValue, String buildValue, int bigCores) {
        final int p = parseThreads(processValue);
        if (p > 0) return p;
        final int b = parseThreads(buildValue);
        return b > 0 ? b : Math.max(1, bigCores);
    }

    /** Set both variables in this process; returns "backend/threads". Never throws. */
    static String apply(String buildBackend, String buildThreads, EnvWriter env) {
        final int cpus = Runtime.getRuntime().availableProcessors();
        final int bigCores = bigCoreCount(
            readMaxFreqs(new File("/sys/devices/system/cpu"), cpus), cpus);
        final String backend = resolveBackend(System.getenv("ELIZA_ASR_BACKEND"), buildBackend);
        final int threads = resolveThreads(System.getenv("ELIZA_ASR_THREADS"), buildThreads, bigCores);
        try {
            env.set("ELIZA_ASR_BACKEND", backend);
            env.set("ELIZA_ASR_THREADS", String.valueOf(threads));
        } catch (Exception e) {
            // The library falls back to its own defaults (auto, big cores capped at 4).
            return "unset (" + e.getClass().getSimpleName() + ")";
        }
        return backend + "/" + threads;
    }
}
