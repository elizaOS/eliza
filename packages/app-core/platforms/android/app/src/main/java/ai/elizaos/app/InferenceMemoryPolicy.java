package ai.elizaos.app;

import android.content.ComponentCallbacks2;

import java.util.Locale;

/**
 * On-device inference memory policy (elizaOS/eliza#11760).
 *
 * <p>Pixel 6a forensics (#11506) showed lmkd killing {@code ai.elizaos.app} at
 * ~3.2 GB RSS on a 5.7 GB-usable device: the in-process Vulkan inference host
 * pins 2.3-2.7 GB of GL mtrack (model weights + KV cache + compute buffers in
 * Mali GPU memory) for as long as the resident inference state exists, which
 * makes the app the largest resident process — lmkd's first target — even when
 * inference is idle. This class owns the pure decision logic for the three
 * levers that fix that:
 *
 * <ol>
 *   <li><b>RAM-class defaults</b> — devices below {@link
 *       #CONSTRAINED_MAX_TOTAL_RAM_BYTES} usable RAM get a smaller default LLM
 *       context ({@link #constrainedLlmContextTokens} vs {@link
 *       #standardLlmContextTokens}), shrinking the persistent KV + compute
 *       footprint of every resident stream.</li>
 *   <li><b>Idle unload</b> — the bionic inference host frees the resident
 *       model + context + stream after {@link #idleUnloadMs} of inactivity.
 *       The next turn reloads on demand ({@code ensureResidentCtx}), trading a
 *       one-off ~7-8 s reload for not being lmkd's standing target.</li>
 *   <li><b>Pressure release</b> — {@code onTrimMemory} levels that signal real
 *       memory pressure ({@link #shouldReleaseOnTrim}) and the availMem poll
 *       ({@link #shouldReleaseOnAvailMem}) free the resident state immediately
 *       so lmkd reclaims 2+ GB without killing the app. Agent/app state lives
 *       outside the inference context, so nothing is lost.</li>
 * </ol>
 *
 * <p>All methods are pure (no Android runtime calls) so the policy is covered
 * by plain JVM unit tests. Callers supply device numbers from
 * {@code ActivityManager.getMemoryInfo()} and overrides from the
 * {@code debug.eliza.inference.*} system properties.
 */
final class InferenceMemoryPolicy {

    private InferenceMemoryPolicy() {
    }

    /** Device RAM class for inference-footprint decisions. */
    enum RamClass {
        /** Below ~7 GiB usable RAM (6 GB-nominal phones like the Pixel 6a report ~5.7 GiB). */
        CONSTRAINED,
        /** Everything else (8 GB-nominal and up). */
        STANDARD;

        String wireName() {
            return name().toLowerCase(Locale.US);
        }
    }

    /**
     * Usable-RAM ceiling for the CONSTRAINED class. 6 GB-nominal devices report
     * ~5.7 GiB usable (Pixel 6a: 5.7 GB, the #11506 device); 8 GB-nominal
     * devices report ~7.3-7.6 GiB. 7 GiB cleanly separates the two.
     */
    static final long CONSTRAINED_MAX_TOTAL_RAM_BYTES = 7L << 30;

    /**
     * Resident LLM context tokens by class. The resident stream's KV cache and
     * non-flash-attn compute buffers scale with n_ctx; 4096 halves the
     * constrained class's persistent KV footprint vs the previous flat 8192
     * (f16 KV on the 2B: ~0.4 GB at 8k → ~0.2 GB at 4k) while still holding a
     * full chat turn; oversized complete prompts are rejected before decode.
     */
    static final int CONSTRAINED_LLM_CONTEXT_TOKENS = 4096;
    static final int STANDARD_LLM_CONTEXT_TOKENS = 8192;

    /**
     * Idle-unload timeouts by class. Constrained devices cannot afford to keep
     * 2+ GB of GPU memory pinned between conversations — 5 min of inactivity
     * frees it (reload is ~7-8 s on Tensor-class hardware). Standard devices
     * keep the model warm much longer (mirrors the desktop engine's 15-min
     * default, doubled because a phone reload is pricier than a desktop one).
     */
    static final long CONSTRAINED_IDLE_UNLOAD_MS = 5L * 60_000L;
    static final long STANDARD_IDLE_UNLOAD_MS = 30L * 60_000L;

    /**
     * Margin above the lmkd threshold at which the CONSTRAINED class releases
     * proactively. Acting only at {@code MemoryInfo.lowMemory} (availMem <=
     * threshold) is often too late — lmkd's PSI path can kill before the app
     * observes the flag. 512 MiB of slack gives the release + GPU reclaim time
     * to land before lmkd picks a victim.
     */
    static final long CONSTRAINED_PRESSURE_MARGIN_BYTES = 512L << 20;

    /**
     * Classify total usable device RAM into a {@link RamClass}. {@code override}
     * ("constrained" / "standard", case-insensitive) wins when present — the
     * verification surface for emulators whose RAM does not match the target
     * class ({@code debug.eliza.inference.ram_class}). Unknown override values
     * are ignored. Non-positive totals classify STANDARD: an unreadable probe
     * must not degrade a healthy device to the constrained profile.
     */
    static RamClass classifyRamClass(long totalRamBytes, String override) {
        if (override != null) {
            String normalized = override.trim().toLowerCase(Locale.US);
            if ("constrained".equals(normalized)) {
                return RamClass.CONSTRAINED;
            }
            if ("standard".equals(normalized)) {
                return RamClass.STANDARD;
            }
        }
        if (totalRamBytes <= 0) {
            return RamClass.STANDARD;
        }
        return totalRamBytes < CONSTRAINED_MAX_TOTAL_RAM_BYTES
            ? RamClass.CONSTRAINED
            : RamClass.STANDARD;
    }

    /** Default resident LLM context (n_ctx) for the class. */
    static int llmContextTokens(RamClass ramClass) {
        return ramClass == RamClass.CONSTRAINED
            ? CONSTRAINED_LLM_CONTEXT_TOKENS
            : STANDARD_LLM_CONTEXT_TOKENS;
    }

    /**
     * Idle-unload timeout for the class. {@code msOverride} (a decimal string,
     * {@code debug.eliza.inference.idle_unload_ms}) wins when parseable;
     * {@code 0} disables idle unload entirely. Negative or garbage overrides
     * are ignored.
     */
    static long idleUnloadMs(RamClass ramClass, String msOverride) {
        if (msOverride != null && !msOverride.trim().isEmpty()) {
            try {
                long parsed = Long.parseLong(msOverride.trim());
                if (parsed >= 0L) {
                    return parsed;
                }
            } catch (NumberFormatException ignored) {
                // Fall through to the class default.
            }
        }
        return ramClass == RamClass.CONSTRAINED
            ? CONSTRAINED_IDLE_UNLOAD_MS
            : STANDARD_IDLE_UNLOAD_MS;
    }

    /**
     * Whether an {@code onTrimMemory(level)} callback should release the
     * resident inference state.
     *
     * <ul>
     *   <li>{@code RUNNING_LOW} / {@code RUNNING_CRITICAL} — the exact #11760
     *       scenario: the app is running (often foreground) and the device is
     *       under pressure. Release.</li>
     *   <li>{@code TRIM_MEMORY_BACKGROUND} and beyond — the app is on the LRU
     *       kill list; a pinned 2+ GB GPU footprint guarantees it goes first.
     *       Release.</li>
     *   <li>{@code UI_HIDDEN} — the screen went away, not memory pressure. The
     *       foreground-service agent keeps answering (notifications, voice), so
     *       unloading here would thrash on every screen-off. Keep.</li>
     *   <li>{@code RUNNING_MODERATE} — too early; the availMem poll and idle
     *       timer cover the gradual case. Keep.</li>
     * </ul>
     */
    static boolean shouldReleaseOnTrim(int level) {
        if (level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW
                || level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL) {
            return true;
        }
        return level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND;
    }

    /**
     * Poll-based pressure check (the reliable path — trim callbacks above
     * {@code UI_HIDDEN}/{@code BACKGROUND} are deprecated for API 34+ targets
     * and lmkd's PSI killer does not wait for them). {@code availMemBytes} and
     * {@code lmkThresholdBytes} come from {@code ActivityManager.getMemoryInfo()};
     * {@code lowMemory} is the same probe's flag.
     *
     * <p>Both classes release at {@code lowMemory}. The CONSTRAINED class also
     * releases within {@link #CONSTRAINED_PRESSURE_MARGIN_BYTES} of the lmkd
     * threshold, because on a 5.7 GB device the gap between "low" and "killed"
     * is a handful of ambient app launches.
     */
    static boolean shouldReleaseOnAvailMem(
            RamClass ramClass, long availMemBytes, long lmkThresholdBytes, boolean lowMemory) {
        if (lowMemory) {
            return true;
        }
        if (ramClass != RamClass.CONSTRAINED) {
            return false;
        }
        if (availMemBytes <= 0 || lmkThresholdBytes <= 0) {
            return false;
        }
        return availMemBytes < lmkThresholdBytes + CONSTRAINED_PRESSURE_MARGIN_BYTES;
    }
}
