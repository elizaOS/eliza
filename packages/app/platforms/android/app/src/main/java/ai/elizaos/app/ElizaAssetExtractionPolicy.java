package ai.elizaos.app;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.util.Enumeration;
import java.util.zip.GZIPOutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

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

    /** APK entry prefix of the agent payload that {@code extractAssetsIfNeeded} stages. */
    static final String AGENT_ASSET_PREFIX = "assets/agent/";

    private static final long FNV_OFFSET = 0xcbf29ce484222325L;
    private static final long FNV_PRIME = 0x100000001b3L;

    private static long mix(long state, long value) {
        for (int i = 0; i < 8; i++) {
            state ^= (value >>> (8 * i)) & 0xffL;
            state *= FNV_PRIME;
        }
        return state;
    }

    private static long mix(long state, String value) {
        for (int i = 0; i < value.length(); i++) {
            state = mix(state, (long) value.charAt(i));
        }
        return state;
    }

    /**
     * A content digest of the agent payload inside an APK, read from the zip
     * central directory only: every {@link #AGENT_ASSET_PREFIX} entry's name,
     * CRC-32 and uncompressed size. Nothing is decompressed, so this stays cheap
     * on a ~200 MB APK, yet any rebuilt agent file changes it. Entry order does
     * not matter. Returns 0 when the APK cannot be read or carries no agent
     * payload.
     */
    static long agentAssetsDigest(File apk) {
        if (apk == null || !apk.isFile()) return 0L;
        long digest = 0L;
        int entries = 0;
        try (ZipFile zip = new ZipFile(apk)) {
            Enumeration<? extends ZipEntry> all = zip.entries();
            while (all.hasMoreElements()) {
                ZipEntry entry = all.nextElement();
                String name = entry.getName();
                if (entry.isDirectory() || !name.startsWith(AGENT_ASSET_PREFIX)) continue;
                long one = mix(FNV_OFFSET, name);
                one = mix(one, entry.getCrc());
                one = mix(one, entry.getSize());
                digest += one;
                entries++;
            }
        } catch (IOException | RuntimeException unreadable) {
            return 0L;
        }
        return entries == 0 ? 0L : mix(digest, (long) entries);
    }

    /**
     * The stamp that identifies the installed APK payload, compared against the
     * {@code .apk-stamp} of the last completed extraction.
     *
     * <p>An APK mtime or {@code lastUpdateTime} alone cannot be the stamp: an
     * AOSP image normalizes every file mtime in /system and /product to the same
     * fixed date, and an image-only update of a /product or /system priv-app
     * does not move {@code lastUpdateTime}, so phones kept booting the agent
     * extracted from the first image. The stamp therefore folds in the APK's
     * size, its {@code longVersionCode} and a content digest of the agent
     * assets, alongside the two timestamps a normal install moves.
     *
     * <p>Returns 0 ("unknown", read as no change) when nothing about the APK
     * could be observed; otherwise a positive value, as the stamp file and
     * {@link #apkChanged} require.
     */
    static long payloadStamp(long apkMtime, long lastUpdateTime, long versionCode,
            long apkSize, long agentAssetsDigest) {
        if (apkMtime <= 0L && lastUpdateTime <= 0L && apkSize <= 0L && agentAssetsDigest == 0L) {
            return 0L;
        }
        long state = FNV_OFFSET;
        state = mix(state, apkMtime);
        state = mix(state, lastUpdateTime);
        state = mix(state, versionCode);
        state = mix(state, apkSize);
        state = mix(state, agentAssetsDigest);
        long stamp = state & Long.MAX_VALUE;
        return stamp == 0L ? 1L : stamp;
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

    /** Suffix of an in-progress copy; a leftover one is from an interrupted run. */
    static final String TEMP_SUFFIX = ".tmp";

    /**
     * The aux tarballs (outside the swapped agent root) follow the agent tree:
     * refresh them when their durable stamp differs from the tree's stamp. The
     * aux stamp is written only after every tarball refreshed, so a kill in
     * between refreshes again on the next boot. An unstamped tree (0) never
     * forces a refresh.
     */
    static boolean auxRefreshDue(long auxStamp, long treeStamp) {
        return treeStamp > 0L && auxStamp != treeStamp;
    }

    /**
     * A re-gzipped tarball is kept only when its gzip trailer records exactly the
     * asset's length (ISIZE is the input length mod 2^32), so a truncated or
     * foreign file is rewritten. {@code gzipInputSize} is -1 when unreadable.
     */
    static boolean tarballCurrent(long gzipInputSize, long assetLength, boolean refreshDue) {
        return !refreshDue
            && gzipInputSize >= 0L
            && assetLength >= 0L
            && gzipInputSize == (assetLength & 0xffffffffL);
    }

    /**
     * Bundled models are stored uncompressed, so a complete copy has the asset's
     * length. When the length is unknown ({@code -1}) the copy is replaced on an
     * aux refresh instead. A model with no asset is never considered here.
     */
    static boolean modelCurrent(long targetLength, long assetLength, boolean auxRefreshDue) {
        if (targetLength <= 0L) return false;
        if (assetLength >= 0L) return targetLength == assetLength;
        return !auxRefreshDue;
    }

    /** The ISIZE trailer of a gzip file, or -1 when it is missing, short or not gzip. */
    static long gzipTrailerSize(File file) {
        if (!file.isFile() || file.length() < 18L) return -1L;
        try (RandomAccessFile in = new RandomAccessFile(file, "r")) {
            if (in.read() != 0x1f || in.read() != 0x8b) return -1L;
            in.seek(file.length() - 4L);
            long size = 0L;
            for (int i = 0; i < 4; i++) size |= ((long) in.read() & 0xffL) << (8 * i);
            return size;
        } catch (IOException unreadable) {
            return -1L;
        }
    }

    /**
     * Delete the leftover {@link #TEMP_SUFFIX} copy of one managed target. Only
     * named targets are cleaned: the same directories hold other components'
     * in-progress files (for example model downloads).
     */
    static boolean deleteStaleTemp(File target) {
        File temp = new File(target.getPath() + TEMP_SUFFIX);
        return temp.isFile() && temp.delete();
    }

    /**
     * Copy {@code in} to {@code target} so a kill never leaves a partial target:
     * write {@code target.tmp}, fsync it, then rename over the target.
     */
    static void writeAtomically(InputStream in, File target, boolean gzip) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("Could not create " + parent);
        }
        File temp = new File(target.getPath() + TEMP_SUFFIX);
        try (FileOutputStream raw = new FileOutputStream(temp)) {
            OutputStream out = gzip ? new GZIPOutputStream(raw, 64 * 1024) : raw;
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
            }
            if (out instanceof GZIPOutputStream) ((GZIPOutputStream) out).finish();
            out.flush();
            raw.getFD().sync();
        } catch (IOException error) {
            temp.delete();
            throw error;
        }
        if (!temp.renameTo(target)) {
            temp.delete();
            throw new IOException("Could not move " + temp + " into place");
        }
    }
}
