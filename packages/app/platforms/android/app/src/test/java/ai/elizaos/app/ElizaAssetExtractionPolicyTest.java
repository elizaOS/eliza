package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

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

    // ── Aux assets: temp-file writes, completeness and the durable aux stamp ──

    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    private static byte[] tarBytes(int size) {
        byte[] bytes = new byte[size];
        for (int i = 0; i < size; i++) bytes[i] = (byte) (i * 31);
        return bytes;
    }

    @Test
    public void truncatedTarballAndStaleTempAreRefreshed() throws IOException {
        File files = temporary.newFolder("files");
        File vector = new File(files, "vector.tar.gz");
        byte[] asset = tarBytes(200_000);
        ElizaAssetExtractionPolicy.writeAtomically(new ByteArrayInputStream(asset), vector, true);
        assertTrue(ElizaAssetExtractionPolicy.tarballCurrent(
            ElizaAssetExtractionPolicy.gzipTrailerSize(vector), asset.length, false));

        // A kill mid-copy under the old in-place writer, plus a leftover temp.
        try (RandomAccessFile file = new RandomAccessFile(vector, "rw")) {
            file.setLength(file.length() / 2);
        }
        File stale = new File(files, "vector.tar.gz.tmp");
        try (FileOutputStream out = new FileOutputStream(stale)) {
            out.write(new byte[] {1, 2, 3});
        }

        assertTrue(ElizaAssetExtractionPolicy.deleteStaleTemp(vector));
        assertFalse(stale.exists());
        assertFalse(ElizaAssetExtractionPolicy.tarballCurrent(
            ElizaAssetExtractionPolicy.gzipTrailerSize(vector), asset.length, false));
        ElizaAssetExtractionPolicy.writeAtomically(new ByteArrayInputStream(asset), vector, true);
        assertTrue(ElizaAssetExtractionPolicy.tarballCurrent(
            ElizaAssetExtractionPolicy.gzipTrailerSize(vector), asset.length, false));
        assertFalse(stale.exists());
    }

    @Test
    public void auxStampOlderThanTheTreeReplacesCompleteTarballs() throws IOException {
        File vector = new File(temporary.newFolder("files"), "vector.tar.gz");
        byte[] asset = tarBytes(4096);
        ElizaAssetExtractionPolicy.writeAtomically(new ByteArrayInputStream(asset), vector, true);
        long trailer = ElizaAssetExtractionPolicy.gzipTrailerSize(vector);

        boolean refreshDue = ElizaAssetExtractionPolicy.auxRefreshDue(
            /* auxStamp */ 1717000000000L, /* treeStamp */ 1718000000000L);
        assertTrue(refreshDue);
        assertFalse(ElizaAssetExtractionPolicy.tarballCurrent(trailer, asset.length, refreshDue));
        // A kill before the aux stamp is written leaves it old: still due next boot.
        assertTrue(ElizaAssetExtractionPolicy.auxRefreshDue(1717000000000L, 1718000000000L));
        assertFalse(ElizaAssetExtractionPolicy.auxRefreshDue(1718000000000L, 1718000000000L));
        // An unstamped tree never forces a refresh.
        assertFalse(ElizaAssetExtractionPolicy.auxRefreshDue(0L, 0L));
    }

    @Test
    public void rawTarOrMissingFileIsNeverCurrent() throws IOException {
        File raw = temporary.newFile("vector.tar.gz");
        Files.write(raw.toPath(), tarBytes(4096));
        assertEquals(-1L, ElizaAssetExtractionPolicy.gzipTrailerSize(raw));
        assertEquals(-1L, ElizaAssetExtractionPolicy.gzipTrailerSize(new File(raw.getParentFile(), "absent")));
        assertFalse(ElizaAssetExtractionPolicy.tarballCurrent(-1L, 4096L, false));
    }

    @Test
    public void modelsAreReplacedOnlyOnALengthMismatch() {
        assertTrue(ElizaAssetExtractionPolicy.modelCurrent(67_000_000L, 67_000_000L, true));
        assertFalse(ElizaAssetExtractionPolicy.modelCurrent(33_000_000L, 67_000_000L, false));
        assertFalse(ElizaAssetExtractionPolicy.modelCurrent(0L, 67_000_000L, false));
        // Unknown asset length: fall back to the aux stamp.
        assertTrue(ElizaAssetExtractionPolicy.modelCurrent(67_000_000L, -1L, false));
        assertFalse(ElizaAssetExtractionPolicy.modelCurrent(67_000_000L, -1L, true));
    }

    // ── payload stamp: image-only updates must move it ──────────────────────

    /** AOSP pins every image file's mtime to 2009-01-01 00:00:00 UTC. */
    private static final long AOSP_IMAGE_MTIME = 1230768000000L;

    private File apk(String name, String bundle, String extraEntry) throws IOException {
        File apk = temporary.newFile(name);
        try (ZipOutputStream zip = new ZipOutputStream(new FileOutputStream(apk))) {
            zip.putNextEntry(new ZipEntry("classes.dex"));
            zip.write("dex".getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
            zip.putNextEntry(new ZipEntry("assets/agent/agent-bundle.js"));
            zip.write(bundle.getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
            if (extraEntry != null) {
                zip.putNextEntry(new ZipEntry(extraEntry));
                zip.write(new byte[] {1, 2, 3});
                zip.closeEntry();
            }
        }
        return apk;
    }

    @Test
    public void imageOnlyUpdateWithPinnedMtimeAndUpdateTimeChangesTheStamp() throws IOException {
        // Same pinned mtime, same lastUpdateTime, same versionCode — only the
        // agent payload inside the /product priv-app differs (alpha.v403).
        File before = apk("before.apk", "console.log('agent v1')", null);
        File after = apk("after.apk", "console.log('agent v2')", null);
        long lastUpdate = 1762000000000L;
        long previous = ElizaAssetExtractionPolicy.payloadStamp(AOSP_IMAGE_MTIME, lastUpdate, 1L,
            before.length(), ElizaAssetExtractionPolicy.agentAssetsDigest(before));
        long current = ElizaAssetExtractionPolicy.payloadStamp(AOSP_IMAGE_MTIME, lastUpdate, 1L,
            after.length(), ElizaAssetExtractionPolicy.agentAssetsDigest(after));
        assertTrue(previous > 0L);
        assertTrue(current > 0L);
        assertTrue(ElizaAssetExtractionPolicy.apkChanged(current, previous));
    }

    @Test
    public void unchangedPayloadKeepsTheSameStampAcrossBoots() throws IOException {
        File installed = apk("installed.apk", "console.log('agent')", "assets/agent/arm64-v8a/bun");
        long digest = ElizaAssetExtractionPolicy.agentAssetsDigest(installed);
        assertTrue(digest != 0L);
        assertEquals(digest, ElizaAssetExtractionPolicy.agentAssetsDigest(installed));
        long stamp = ElizaAssetExtractionPolicy.payloadStamp(AOSP_IMAGE_MTIME, 1L, 7L, installed.length(), digest);
        assertFalse(ElizaAssetExtractionPolicy.apkChanged(
            ElizaAssetExtractionPolicy.payloadStamp(AOSP_IMAGE_MTIME, 1L, 7L, installed.length(), digest), stamp));
    }

    @Test
    public void agentDigestCoversEveryAgentEntryButNotOtherFiles() throws IOException {
        long base = ElizaAssetExtractionPolicy.agentAssetsDigest(apk("base.apk", "bundle", null));
        long withRuntime = ElizaAssetExtractionPolicy.agentAssetsDigest(
            apk("runtime.apk", "bundle", "assets/agent/arm64-v8a/bun"));
        long withOther = ElizaAssetExtractionPolicy.agentAssetsDigest(apk("other.apk", "bundle", "res/raw/x"));
        assertTrue(base != withRuntime);
        assertEquals(base, withOther);
    }

    @Test
    public void versionCodeOrSizeAloneMovesTheStamp() {
        long stamp = ElizaAssetExtractionPolicy.payloadStamp(AOSP_IMAGE_MTIME, 5L, 10L, 1000L, 42L);
        assertTrue(ElizaAssetExtractionPolicy.apkChanged(
            ElizaAssetExtractionPolicy.payloadStamp(AOSP_IMAGE_MTIME, 5L, 11L, 1000L, 42L), stamp));
        assertTrue(ElizaAssetExtractionPolicy.apkChanged(
            ElizaAssetExtractionPolicy.payloadStamp(AOSP_IMAGE_MTIME, 5L, 10L, 1001L, 42L), stamp));
    }

    @Test
    public void unreadableApkIsAnUnknownStamp() {
        assertEquals(0L, ElizaAssetExtractionPolicy.agentAssetsDigest(new File(temporary.getRoot(), "absent.apk")));
        assertEquals(0L, ElizaAssetExtractionPolicy.payloadStamp(0L, 0L, 3L, 0L, 0L));
        // Unknown reads as no change, so it never re-stages a working tree.
        assertFalse(ElizaAssetExtractionPolicy.apkChanged(
            ElizaAssetExtractionPolicy.payloadStamp(0L, 0L, 3L, 0L, 0L), 12345L));
    }
}
