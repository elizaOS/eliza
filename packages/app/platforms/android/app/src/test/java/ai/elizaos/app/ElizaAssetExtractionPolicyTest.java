package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * JVM unit tests for the #12453 crash-safe asset-extraction decision. Pure
 * decision logic — asserts the three brick-avoidance invariants directly:
 * only a full-APK change/broken-extraction re-stages (and only re-staging
 * advances the stamp), a UI-only build never wipes a working extraction, and a
 * no-assets/no-extraction state fails loudly instead of looping on a wipe.
 */
public class ElizaAssetExtractionPolicyTest {

    // ── apkChanged ─────────────────────────────────────────────────────────

    @Test
    public void unknownApkTimeIsNeverAChange() {
        // A failed package lookup (apkUpdateTime == 0) must not read as a change,
        // or an early-boot lookup failure would trigger a needless wipe.
        assertFalse(ElizaAssetExtractionPolicy.apkChanged(0L, 0L));
        assertFalse(ElizaAssetExtractionPolicy.apkChanged(0L, 12345L));
    }

    @Test
    public void matchingStampIsNotAChange() {
        assertFalse(ElizaAssetExtractionPolicy.apkChanged(1717000000000L, 1717000000000L));
    }

    @Test
    public void differingStampIsAChange() {
        assertTrue(ElizaAssetExtractionPolicy.apkChanged(1717000000001L, 1717000000000L));
        // Fresh install: no stamp yet (0) vs a real APK time.
        assertTrue(ElizaAssetExtractionPolicy.apkChanged(1717000000000L, 0L));
    }

    // ── Steady state: boot the existing extraction ─────────────────────────

    @Test
    public void unchangedFullApkWithValidExtractionBootsAsIs() {
        assertEquals(
            ElizaAssetExtractionPolicy.Action.USE_EXISTING,
            ElizaAssetExtractionPolicy.decide(
                /* apkChanged */ false, /* apkHasAgentAssets */ true, /* haveValidExtraction */ true));
    }

    // ── When-to-wipe: STAGE_AND_SWAP is the only re-staging action ──────────

    @Test
    public void changedFullApkRestages() {
        assertEquals(
            ElizaAssetExtractionPolicy.Action.STAGE_AND_SWAP,
            ElizaAssetExtractionPolicy.decide(true, true, true));
    }

    @Test
    public void freshInstallStages() {
        // No prior extraction, APK ships assets, treated as a change.
        assertEquals(
            ElizaAssetExtractionPolicy.Action.STAGE_AND_SWAP,
            ElizaAssetExtractionPolicy.decide(true, true, false));
    }

    @Test
    public void brokenExtractionSelfHealsEvenWhenStampMatches() {
        // A partial/corrupted extraction whose stamp still matches (e.g. a
        // pre-#12453 interrupted wipe) must be rebuilt, not booted.
        assertEquals(
            ElizaAssetExtractionPolicy.Action.STAGE_AND_SWAP,
            ElizaAssetExtractionPolicy.decide(false, true, false));
    }

    // ── Missing-assets guard: UI-only build never wipes a full install ─────

    @Test
    public void uiOnlyBuildOverFullInstallKeepsExtraction() {
        // The #12453 variant-swap brick: a UI-only APK bumps the mtime but ships
        // no assets/agent/*. With a valid extraction present it must be KEPT.
        assertEquals(
            ElizaAssetExtractionPolicy.Action.KEEP_MISSING_ASSETS,
            ElizaAssetExtractionPolicy.decide(true, false, true));
    }

    @Test
    public void noAssetsNeverWipesRegardlessOfChangeFlag() {
        // Whether or not the change flag is set, a build without agent assets
        // must never re-stage over a working extraction.
        assertEquals(
            ElizaAssetExtractionPolicy.Action.KEEP_MISSING_ASSETS,
            ElizaAssetExtractionPolicy.decide(false, false, true));
        assertEquals(
            ElizaAssetExtractionPolicy.Action.KEEP_MISSING_ASSETS,
            ElizaAssetExtractionPolicy.decide(true, false, true));
    }

    // ── Unrecoverable: fail loudly instead of looping on a wipe ────────────

    @Test
    public void noAssetsAndNoExtractionFails() {
        assertEquals(
            ElizaAssetExtractionPolicy.Action.FAIL_NO_ASSETS,
            ElizaAssetExtractionPolicy.decide(true, false, false));
        assertEquals(
            ElizaAssetExtractionPolicy.Action.FAIL_NO_ASSETS,
            ElizaAssetExtractionPolicy.decide(false, false, false));
    }

    // ── Invariants swept over the full input space ─────────────────────────

    @Test
    public void onlyStageAndSwapEverWipesAndStamps() {
        // Enumerate all eight (apkChanged, apkHasAgentAssets, haveValid) inputs.
        // STAGE_AND_SWAP — the only action that wipes/re-stages and advances the
        // stamp — must occur iff the APK ships assets AND (it changed OR there is
        // no valid extraction). Nothing else may re-stage.
        for (int mask = 0; mask < 8; mask++) {
            boolean apkChanged = (mask & 1) != 0;
            boolean hasAssets = (mask & 2) != 0;
            boolean valid = (mask & 4) != 0;
            ElizaAssetExtractionPolicy.Action action =
                ElizaAssetExtractionPolicy.decide(apkChanged, hasAssets, valid);
            boolean shouldStage = hasAssets && (apkChanged || !valid);
            assertEquals(
                "stage decision for changed=" + apkChanged + " assets=" + hasAssets + " valid=" + valid,
                shouldStage,
                action == ElizaAssetExtractionPolicy.Action.STAGE_AND_SWAP);
        }
    }

    @Test
    public void aValidExtractionIsNeverDestroyed() {
        // With a bootable extraction present, no input may resolve to the
        // unrecoverable failure state — the last-good tree always survives.
        for (int mask = 0; mask < 4; mask++) {
            boolean apkChanged = (mask & 1) != 0;
            boolean hasAssets = (mask & 2) != 0;
            ElizaAssetExtractionPolicy.Action action =
                ElizaAssetExtractionPolicy.decide(apkChanged, hasAssets, /* haveValid */ true);
            assertFalse(
                "valid extraction must never fail for changed=" + apkChanged + " assets=" + hasAssets,
                action == ElizaAssetExtractionPolicy.Action.FAIL_NO_ASSETS);
        }
    }
}
