package ai.elizaos.app;

/**
 * Pure crash-safety decision for {@link ElizaAgentService}'s on-device agent
 * asset extraction (elizaOS/eliza#12453).
 *
 * <p>The service's cold-boot extraction used to wipe the previously-extracted
 * ~170 MB agent bundle BEFORE staging the replacement and only stamped on full
 * success, so any interruption of the copy (ANR, LMK-kill, crash) or a build
 * variant that lacked the assets left the on-disk agent partial and dropped the
 * app into a permanent {@code extract-failed} loop with no recovery. This class
 * owns the one decision that makes extraction crash-safe: given whether the APK
 * changed, whether it actually ships {@code assets/agent/*}, and whether a
 * bootable extraction already exists, decide whether to atomically re-stage,
 * keep the existing extraction untouched, or fail loudly.
 *
 * <p>Kept free of Android framework calls so the invariants — never wipe a
 * working extraction, never advance the stamp on a partial run, never brick a
 * full-agent install with a UI-only build — are exercised by plain JVM unit
 * tests without a device. The service supplies the three booleans from real
 * AssetManager / filesystem probes and executes the returned action.
 */
final class ElizaAssetExtractionPolicy {
    private ElizaAssetExtractionPolicy() {}

    enum Action {
        /** Stamp matches and a bootable extraction exists — boot it as-is. */
        USE_EXISTING,
        /**
         * The APK changed (or the extraction is broken) and the APK ships the
         * agent assets — stage the payload into a temp dir, atomically swap it
         * into place, then write the stamp. The ONLY action that wipes/re-stages
         * and the ONLY one that advances the stamp.
         */
        STAGE_AND_SWAP,
        /**
         * The APK ships NO {@code assets/agent/*} (a UI-only / WebView-debug
         * build) but a bootable extraction already exists — keep it, do NOT
         * wipe, do NOT advance the stamp. A UI-only build must never brick a
         * working full-agent install.
         */
        KEEP_MISSING_ASSETS,
        /**
         * The APK ships no agent assets AND there is no bootable extraction to
         * fall back to — unrecoverable; fail loudly rather than loop on a wipe.
         */
        FAIL_NO_ASSETS,
    }

    /**
     * An APK payload change is a known, non-zero timestamp that differs from the
     * stamp of the last completed extraction. An unknown ({@code 0}) APK time
     * reads as "no change" so a failed package lookup can never trigger a wipe.
     */
    static boolean apkChanged(long apkUpdateTime, long stampedUpdateTime) {
        return apkUpdateTime > 0L && apkUpdateTime != stampedUpdateTime;
    }

    /**
     * @param apkChanged           the installed APK payload differs from the stamp
     * @param apkHasAgentAssets    the APK actually ships {@code assets/agent/*}
     * @param haveValidExtraction  an on-disk extraction is bootable right now
     */
    static Action decide(boolean apkChanged, boolean apkHasAgentAssets, boolean haveValidExtraction) {
        if (apkHasAgentAssets) {
            // Re-stage on a real APK change, and self-heal a broken extraction
            // even when the stamp matches (corruption / partial legacy wipe).
            if (apkChanged || !haveValidExtraction) {
                return Action.STAGE_AND_SWAP;
            }
            return Action.USE_EXISTING;
        }
        // The APK carries no agent payload (UI-only build).
        if (haveValidExtraction) {
            return Action.KEEP_MISSING_ASSETS;
        }
        return Action.FAIL_NO_ASSETS;
    }
}
