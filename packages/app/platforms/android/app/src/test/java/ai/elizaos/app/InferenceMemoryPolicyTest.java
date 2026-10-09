package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.ComponentCallbacks2;

import org.junit.Test;

/**
 * JVM unit tests for the #11760 inference memory policy. Pure decision logic —
 * the numbers mirror the real devices from the forensics: the Pixel 6a
 * (5.7 GB usable, the #11506 LMK-kill device) must classify CONSTRAINED and an
 * 8 GB-nominal device (~7.75 GiB usable) must classify STANDARD.
 */
public class InferenceMemoryPolicyTest {

    private static final long GIB = 1L << 30;

    // ── RAM-class classification ────────────────────────────────────────

    @Test
    public void pixel6aClassifiesConstrained() {
        // Pixel 6a reports ~5.7 GiB usable (#11506 forensics).
        long pixel6aTotal = (long) (5.7 * GIB);
        assertEquals(
            InferenceMemoryPolicy.RamClass.CONSTRAINED,
            InferenceMemoryPolicy.classifyRamClass(pixel6aTotal, null));
    }

    @Test
    public void eightGbNominalClassifiesStandard() {
        // 8 GB-nominal devices report ~7.3-7.75 GiB usable (e.g. the arm64
        // emulator AVD reports MemTotal 8129212 kB ≈ 7.75 GiB).
        long emulatorTotal = 8129212L * 1024L;
        assertEquals(
            InferenceMemoryPolicy.RamClass.STANDARD,
            InferenceMemoryPolicy.classifyRamClass(emulatorTotal, null));
    }

    @Test
    public void boundaryExactlySevenGibIsStandard() {
        assertEquals(
            InferenceMemoryPolicy.RamClass.STANDARD,
            InferenceMemoryPolicy.classifyRamClass(
                InferenceMemoryPolicy.CONSTRAINED_MAX_TOTAL_RAM_BYTES, null));
        assertEquals(
            InferenceMemoryPolicy.RamClass.CONSTRAINED,
            InferenceMemoryPolicy.classifyRamClass(
                InferenceMemoryPolicy.CONSTRAINED_MAX_TOTAL_RAM_BYTES - 1, null));
    }

    @Test
    public void unreadableProbeClassifiesStandard() {
        // A broken probe must not degrade a healthy device to the constrained
        // profile.
        assertEquals(
            InferenceMemoryPolicy.RamClass.STANDARD,
            InferenceMemoryPolicy.classifyRamClass(0, null));
        assertEquals(
            InferenceMemoryPolicy.RamClass.STANDARD,
            InferenceMemoryPolicy.classifyRamClass(-1, null));
    }

    @Test
    public void overrideWinsOverMeasuredRam() {
        // The emulator-verification surface: debug.eliza.inference.ram_class.
        assertEquals(
            InferenceMemoryPolicy.RamClass.CONSTRAINED,
            InferenceMemoryPolicy.classifyRamClass(16 * GIB, "constrained"));
        assertEquals(
            InferenceMemoryPolicy.RamClass.STANDARD,
            InferenceMemoryPolicy.classifyRamClass(4 * GIB, "standard"));
        assertEquals(
            InferenceMemoryPolicy.RamClass.CONSTRAINED,
            InferenceMemoryPolicy.classifyRamClass(16 * GIB, "  CONSTRAINED "));
    }

    @Test
    public void junkOverrideIsIgnored() {
        assertEquals(
            InferenceMemoryPolicy.RamClass.CONSTRAINED,
            InferenceMemoryPolicy.classifyRamClass(4 * GIB, "turbo"));
        assertEquals(
            InferenceMemoryPolicy.RamClass.CONSTRAINED,
            InferenceMemoryPolicy.classifyRamClass(4 * GIB, ""));
    }

    // ── Per-class defaults ──────────────────────────────────────────────

    @Test
    public void contextTokensByClass() {
        assertEquals(4096, InferenceMemoryPolicy.llmContextTokens(
            InferenceMemoryPolicy.RamClass.CONSTRAINED));
        assertEquals(8192, InferenceMemoryPolicy.llmContextTokens(
            InferenceMemoryPolicy.RamClass.STANDARD));
    }

    @Test
    public void idleUnloadDefaultsByClass() {
        assertEquals(5L * 60_000L, InferenceMemoryPolicy.idleUnloadMs(
            InferenceMemoryPolicy.RamClass.CONSTRAINED, null));
        assertEquals(30L * 60_000L, InferenceMemoryPolicy.idleUnloadMs(
            InferenceMemoryPolicy.RamClass.STANDARD, null));
    }

    @Test
    public void idleUnloadOverrideParsesAndZeroDisables() {
        assertEquals(60_000L, InferenceMemoryPolicy.idleUnloadMs(
            InferenceMemoryPolicy.RamClass.STANDARD, "60000"));
        assertEquals(0L, InferenceMemoryPolicy.idleUnloadMs(
            InferenceMemoryPolicy.RamClass.CONSTRAINED, "0"));
    }

    @Test
    public void idleUnloadGarbageOverrideFallsBack() {
        assertEquals(
            InferenceMemoryPolicy.CONSTRAINED_IDLE_UNLOAD_MS,
            InferenceMemoryPolicy.idleUnloadMs(
                InferenceMemoryPolicy.RamClass.CONSTRAINED, "-5"));
        assertEquals(
            InferenceMemoryPolicy.STANDARD_IDLE_UNLOAD_MS,
            InferenceMemoryPolicy.idleUnloadMs(
                InferenceMemoryPolicy.RamClass.STANDARD, "soon"));
        assertEquals(
            InferenceMemoryPolicy.STANDARD_IDLE_UNLOAD_MS,
            InferenceMemoryPolicy.idleUnloadMs(
                InferenceMemoryPolicy.RamClass.STANDARD, "  "));
    }

    // ── Trim-level decisions ────────────────────────────────────────────

    @Test
    public void runningPressureLevelsRelease() {
        assertTrue(InferenceMemoryPolicy.shouldReleaseOnTrim(
            ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW));
        assertTrue(InferenceMemoryPolicy.shouldReleaseOnTrim(
            ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL));
    }

    @Test
    public void backgroundLruLevelsRelease() {
        assertTrue(InferenceMemoryPolicy.shouldReleaseOnTrim(
            ComponentCallbacks2.TRIM_MEMORY_BACKGROUND));
        assertTrue(InferenceMemoryPolicy.shouldReleaseOnTrim(
            ComponentCallbacks2.TRIM_MEMORY_MODERATE));
        assertTrue(InferenceMemoryPolicy.shouldReleaseOnTrim(
            ComponentCallbacks2.TRIM_MEMORY_COMPLETE));
    }

    @Test
    public void benignLevelsKeepResidentState() {
        // UI_HIDDEN is screen-off, not pressure — unloading there would thrash
        // the model on every pocket. RUNNING_MODERATE is covered by the poll.
        assertFalse(InferenceMemoryPolicy.shouldReleaseOnTrim(
            ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN));
        assertFalse(InferenceMemoryPolicy.shouldReleaseOnTrim(
            ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE));
    }

    // ── availMem poll decisions ─────────────────────────────────────────

    @Test
    public void lowMemoryFlagReleasesBothClasses() {
        assertTrue(InferenceMemoryPolicy.shouldReleaseOnAvailMem(
            InferenceMemoryPolicy.RamClass.CONSTRAINED, 2 * GIB, GIB, true));
        assertTrue(InferenceMemoryPolicy.shouldReleaseOnAvailMem(
            InferenceMemoryPolicy.RamClass.STANDARD, 2 * GIB, GIB, true));
    }

    @Test
    public void constrainedReleasesWithinMarginOfLmkThreshold() {
        long threshold = GIB; // typical lmkd minfree-derived threshold
        long insideMargin =
            threshold + InferenceMemoryPolicy.CONSTRAINED_PRESSURE_MARGIN_BYTES - 1;
        long outsideMargin =
            threshold + InferenceMemoryPolicy.CONSTRAINED_PRESSURE_MARGIN_BYTES + 1;
        assertTrue(InferenceMemoryPolicy.shouldReleaseOnAvailMem(
            InferenceMemoryPolicy.RamClass.CONSTRAINED, insideMargin, threshold, false));
        assertFalse(InferenceMemoryPolicy.shouldReleaseOnAvailMem(
            InferenceMemoryPolicy.RamClass.CONSTRAINED, outsideMargin, threshold, false));
    }

    @Test
    public void standardOnlyReleasesOnLowMemoryFlag() {
        long threshold = GIB;
        assertFalse(InferenceMemoryPolicy.shouldReleaseOnAvailMem(
            InferenceMemoryPolicy.RamClass.STANDARD, threshold + 1, threshold, false));
    }

    @Test
    public void availMemPollIgnoresUnreadableProbes() {
        assertFalse(InferenceMemoryPolicy.shouldReleaseOnAvailMem(
            InferenceMemoryPolicy.RamClass.CONSTRAINED, 0, GIB, false));
        assertFalse(InferenceMemoryPolicy.shouldReleaseOnAvailMem(
            InferenceMemoryPolicy.RamClass.CONSTRAINED, GIB, 0, false));
    }
}
