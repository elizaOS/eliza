package ai.elizaos.app;

/**
 * Device RAM-tier policy for the bundled on-device agent (elizaOS/eliza#14390).
 *
 * <p>Low-RAM phones cannot sustain the Bun agent runtime: a 4 GB Moto G Play
 * (2024) wedges boot for the full 180 s startup budget before surfacing a
 * "Backend Timeout" card. The product policy is RAM-driven, not build-driven —
 * a device below the 8 GB marketed-RAM floor is cloud-only and must never spawn
 * the local agent, no matter which APK variant is installed or what runtime
 * mode an older install persisted (the mode survives reinstalls via Capacitor
 * Preferences).
 *
 * <p>{@code ActivityManager.MemoryInfo.totalMem} under-reports the marketed
 * capacity because the kernel/carveout reserve a slice (a marketed "4 GB"
 * device reports ~3.6 GiB, an "8 GB" one ~7.2-7.6 GiB), so the policy first
 * rounds the reading UP to the next whole GiB — recovering the marketed size —
 * and applies the floor to that. The renderer mirrors this exact conversion in
 * {@code packages/ui/src/first-run/device-ram-tier.ts} (which also owns the
 * 12/16 GB local-model tiers); keep the two in sync.
 *
 * <p>All methods are pure (no Android runtime calls) so the policy is covered
 * by plain JVM unit tests; callers supply {@code totalMem} bytes.
 */
final class DeviceRamTierPolicy {

    private DeviceRamTierPolicy() {
    }

    /** Marketed-RAM floor (GB) below which the on-device agent is disabled. */
    static final int LOCAL_AGENT_MIN_MARKETED_RAM_GB = 8;

    private static final long ONE_GIB = 1L << 30;

    /**
     * The device's marketed RAM size in GB recovered from a raw
     * {@code totalMem} reading (round up to the next whole GiB), or -1 when the
     * reading is absent/invalid ({@code <= 0}) — never a fabricated size.
     */
    static int marketedRamGb(long totalMemBytes) {
        if (totalMemBytes <= 0) return -1;
        return (int) ((totalMemBytes + ONE_GIB - 1) / ONE_GIB);
    }

    /**
     * Whether this device may run the bundled on-device agent at all.
     *
     * <p>An unreadable {@code totalMem} (no ActivityManager — not observed on
     * any real device) fails OPEN: the only mode that consults this gate is an
     * explicit user "local" choice, and bricking that choice on a probe failure
     * would be worse than the wedge it guards against.
     */
    static boolean allowsLocalAgent(long totalMemBytes) {
        int marketed = marketedRamGb(totalMemBytes);
        if (marketed < 0) return true;
        return marketed >= LOCAL_AGENT_MIN_MARKETED_RAM_GB;
    }
}
