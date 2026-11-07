package ai.eliza.voice;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.AssetFileDescriptor;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Copies the APK's pinned voice bundle to app storage and checks every file
 * against the SHA-256 in the bundle manifest. The bundle uses the
 * libelizainference layout: {@code tts/paradee/} holds the Paradee GGUF, the
 * misaki lexicon and the optional eSpeak NG data; {@code asr/} holds the
 * Phonon-2 GGUF when the bundle carries one. The host chooses a private directory
 * beneath filesDir; no renderer path or URL is accepted. Run it on a worker thread.
 * This installer never loads a native library or opens a model context.
 *
 * <p>Manifest {@code eliza-paradee-voice-v2} may add {@code voices}: more speech
 * languages, each a Paradee-family GGUF in the bundle (for example
 * {@code "es": "tts/paradee/delibes-8m-eses.gguf"}, Castilian Spanish, which uses
 * the bundle's eSpeak NG data and no lexicon). A v2 manifest without
 * {@code voices} (a build with inputs.json {@code spanish.enabled} false) and an
 * {@code eliza-paradee-voice-v1} manifest install with no extra voices.
 *
 * <p>With the {@link #MODELS_IN_PLACE_METADATA} meta-data set to true, a
 * {@code .gguf} or {@code .lex} file under {@code asr/} or {@code tts/} that the
 * APK stores uncompressed at a 16-byte-aligned offset is not copied: its
 * installed path holds a libelizainference region file that names the bytes
 * in the APK, and the native loaders map them from there. The bytes are hashed
 * in the APK instead, once per manifest. Any other file, and every file without the meta-data, is
 * copied. Only a libelizainference with region-file support can load such a
 * bundle.
 */
public final class VoiceBundleAssets {
    public static final String ASSET_ROOT = "paradee-voice/v1";
    private static final String FORMAT = "eliza-paradee-voice-v1";
    private static final String FORMAT_V2 = "eliza-paradee-voice-v2";
    public static final String DIRECTORY_METADATA = "ai.eliza.voice.BUNDLE_DIRECTORY";
    /** Boolean meta-data: point the native loaders at the APK's model assets instead of copying them. */
    public static final String MODELS_IN_PLACE_METADATA = "ai.eliza.voice.MODELS_IN_PLACE";
    /** First line of a libelizainference region file (tools/file-region). */
    static final String REGION_MAGIC = "eliza-file-region v1";
    private static final long REGION_ALIGNMENT = 16;

    /** Installed file locations. */
    public static final class Installation {
        /** Installed model root; the host owns any native model session. */
        public final File root;
        public final File model;
        public final File lexicon;
        /** Directory that contains {@code espeak-ng-data}, or null. */
        public final File espeakDir;
        /** More speech languages (v2 manifests): language code to its GGUF. Never null. */
        public final java.util.Map<String, File> voices;

        Installation(File root, File model, File lexicon, File espeakDir) {
            this(root, model, lexicon, espeakDir, java.util.Collections.emptyMap());
        }

        Installation(File root, File model, File lexicon, File espeakDir, java.util.Map<String, File> voices) {
            this.root = root;
            this.model = model;
            this.lexicon = lexicon;
            this.espeakDir = espeakDir;
            this.voices = java.util.Collections.unmodifiableMap(new java.util.TreeMap<>(voices));
        }

    }

    private VoiceBundleAssets() {}

    /** Product storage identity; the default preserves existing downstream installations. */
    public static File bundleRoot(Context context) throws IOException {
        Object value = metaData(context, DIRECTORY_METADATA);
        if (value != null && !(value instanceof String)) throw new IOException("Invalid voice storage identity");
        return resolve(context.getFilesDir(), value == null ? "paradee-voice-v1" : (String) value);
    }

    private static Object metaData(Context context, String key) throws IOException {
        try {
            ApplicationInfo info = context.getPackageManager().getApplicationInfo(context.getPackageName(), PackageManager.GET_META_DATA);
            return info.metaData == null ? null : info.metaData.get(key);
        } catch (PackageManager.NameNotFoundException error) {
            throw new IOException("Voice storage identity unavailable", error);
        }
    }

    /** Absence is allowed in explicit cloud/host-test packages; malformed present bundles still fail. */
    public static boolean isPackaged(Context context) throws IOException {
        String[] names = context.getAssets().list(ASSET_ROOT);
        return names != null && Arrays.asList(names).contains("manifest.json");
    }

    public static Installation install(Context context) throws IOException {
        Object inPlace = metaData(context, MODELS_IN_PLACE_METADATA);
        if (inPlace != null && !(inPlace instanceof Boolean)) throw new IOException("Invalid voice model placement");
        return install(context, bundleRoot(context), Boolean.TRUE.equals(inPlace));
    }

    /**
     * The speech languages of the APK's bundle, read from its manifest without
     * installing anything: "en", then each extra voice. Fast enough for a
     * status read before the first install.
     */
    public static java.util.List<String> packagedLanguages(Context context) throws IOException {
        java.util.List<String> languages = new java.util.ArrayList<>();
        languages.add("en");
        for (String language : voices(parse(read(context.getAssets().open(ASSET_ROOT + "/manifest.json"), 1 << 20))).keySet()) {
            if (!"en".equals(language)) languages.add(language);
        }
        return languages;
    }

    private static JSONObject parse(byte[] manifestBytes) throws IOException {
        try {
            JSONObject manifest = new JSONObject(new String(manifestBytes, StandardCharsets.UTF_8));
            String format = manifest.getString("format");
            if (!FORMAT.equals(format) && !FORMAT_V2.equals(format)) throw new IOException("Unsupported voice bundle");
            return manifest;
        } catch (org.json.JSONException error) {
            throw new IOException("Invalid voice bundle manifest", error);
        }
    }

    /** Extra speech languages (v2 manifests only) to their bundle paths; English is the default voice. */
    private static java.util.Map<String, String> voices(JSONObject manifest) throws IOException {
        java.util.Map<String, String> voices = new java.util.TreeMap<>();
        try {
            JSONObject extra = FORMAT_V2.equals(manifest.getString("format")) ? manifest.optJSONObject("voices") : null;
            if (extra != null) {
                for (java.util.Iterator<String> it = extra.keys(); it.hasNext(); ) {
                    String language = it.next();
                    if (!language.matches("[a-z]{2,3}")) throw new IOException("Invalid voice bundle language");
                    voices.put(language, extra.getString(language));
                }
            }
        } catch (org.json.JSONException error) {
            throw new IOException("Invalid voice bundle manifest", error);
        }
        return voices;
    }

    private static synchronized Installation install(Context context, File root, boolean inPlace) throws IOException {
        byte[] manifestBytes = read(context.getAssets().open(ASSET_ROOT + "/manifest.json"), 1 << 20);
        JSONObject manifest = parse(manifestBytes);
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("Voice storage unavailable");
        File stamp = new File(root, "installed-manifest.json");
        boolean verified = stamp.isFile() && Arrays.equals(read(new FileInputStream(stamp), 1 << 20), manifestBytes);
        try {
            JSONArray files = manifest.getJSONArray("files");
            for (int i = 0; i < files.length(); i++) {
                JSONObject entry = files.getJSONObject(i);
                String relative = entry.getString("path");
                File target = resolve(root, relative);
                long bytes = entry.getLong("bytes");
                String sha = entry.getString("sha256");
                Region region = inPlace && inPlaceEligible(relative) ? region(context, relative, bytes) : null;
                if (region != null) {
                    link(target, region, verified, sha, relative);
                    continue;
                }
                // A matching stamp means every file was hashed after the last copy.
                if (verified && target.length() == bytes) continue;
                if (target.isFile() && target.length() == bytes && sha.equals(sha256(target))) continue;
                copy(context, relative, target, bytes, sha);
            }
            try (OutputStream out = new FileOutputStream(stamp)) {
                out.write(manifestBytes);
            }
            String espeak = manifest.optString("espeakDir", "");
            java.util.Map<String, File> voices = new java.util.TreeMap<>();
            for (java.util.Map.Entry<String, String> voice : voices(manifest).entrySet()) {
                voices.put(voice.getKey(), resolve(root, voice.getValue()));
            }
            return new Installation(
                    root,
                    resolve(root, manifest.getString("model")),
                    resolve(root, manifest.getString("lexicon")),
                    espeak.isEmpty() ? null : resolve(root, espeak),
                    voices);
        } catch (org.json.JSONException error) {
            throw new IOException("Invalid voice bundle manifest", error);
        }
    }

    private static File resolve(File root, String relative) throws IOException {
        File file = new File(root, relative);
        String base = root.getCanonicalPath() + File.separator;
        if (!relative.matches("[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*")
                || Arrays.stream(relative.split("/")).anyMatch(part -> part.equals(".") || part.equals(".."))
                || !file.getCanonicalPath().startsWith(base)) {
            throw new IOException("Invalid voice bundle path");
        }
        return file;
    }

    /** Model files the native loaders can read through a region file. */
    static boolean inPlaceEligible(String relative) {
        return (relative.startsWith("asr/") || relative.startsWith("tts/"))
                && (relative.endsWith(".gguf") || relative.endsWith(".lex"));
    }

    /** Where an uncompressed asset's bytes are in the APK. */
    private static final class Region {
        final File apk;
        final long offset, length;

        Region(File apk, long offset, long length) {
            this.apk = apk;
            this.offset = offset;
            this.length = length;
        }

        /** The libelizainference region file (tools/file-region/eliza-file-region.h). */
        byte[] text() {
            return (REGION_MAGIC + "\noffset=" + offset + "\nlength=" + length + "\npath=" + apk.getPath() + "\n")
                    .getBytes(StandardCharsets.UTF_8);
        }
    }

    /** The asset's place in the APK, or null when it is compressed or unaligned (it is then copied). */
    private static Region region(Context context, String relative, long bytes) throws IOException {
        AssetFileDescriptor fd;
        try {
            fd = context.getAssets().openFd(ASSET_ROOT + "/" + relative);
        } catch (java.io.FileNotFoundException compressed) {
            return null;
        }
        try (AssetFileDescriptor asset = fd) {
            long offset = asset.getStartOffset();
            if (asset.getLength() != bytes || offset % REGION_ALIGNMENT != 0) return null;
            String apk;
            try {
                apk = android.system.Os.readlink("/proc/self/fd/" + asset.getParcelFileDescriptor().getFd());
            } catch (android.system.ErrnoException error) {
                throw new IOException("Voice asset location unavailable: " + relative, error);
            }
            if (!apk.startsWith("/")) throw new IOException("Voice asset location unavailable: " + relative);
            return new Region(new File(apk), offset, bytes);
        }
    }

    /**
     * Writes the region file for an APK asset. The asset's bytes are hashed only
     * when the manifest changed since the last verified install. With the same
     * manifest (for example an app update, which moves the APK) the package
     * manager has already checked the APK's signature, and the manifest pins the
     * bytes, so only the region file is rewritten, as the copy path skips work.
     */
    private static void link(File target, Region region, boolean verified, String sha, String relative)
            throws IOException {
        byte[] text = region.text();
        if (verified && target.isFile() && target.length() == text.length
                && Arrays.equals(read(new FileInputStream(target), text.length), text)) {
            return;
        }
        if (!verified && !sha.equals(sha256(region.apk, region.offset, region.length))) {
            throw new IOException("Voice asset checksum mismatch: " + relative);
        }
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Voice storage unavailable");
        File partial = new File(target.getPath() + ".partial");
        try (OutputStream out = new FileOutputStream(partial)) {
            out.write(text);
        }
        // Replaces a previous copy of the model, which frees its storage.
        if (!partial.renameTo(target)) throw new IOException("Voice asset install failed: " + relative);
    }

    private static void copy(Context context, String relative, File target, long bytes, String sha)
            throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Voice storage unavailable");
        File partial = new File(target.getPath() + ".partial");
        long total = 0;
        try (InputStream in = context.getAssets().open(ASSET_ROOT + "/" + relative);
                OutputStream out = new FileOutputStream(partial)) {
            byte[] block = new byte[1 << 16];
            for (int n; (n = in.read(block)) != -1; ) {
                total += n;
                if (total > bytes) throw new IOException("Voice asset larger than manifest: " + relative);
                out.write(block, 0, n);
            }
        }
        if (total != bytes || !sha.equals(sha256(partial))) {
            partial.delete();
            throw new IOException("Voice asset checksum mismatch: " + relative);
        }
        if (!partial.renameTo(target)) throw new IOException("Voice asset install failed: " + relative);
    }

    private static byte[] read(InputStream input, int limit) throws IOException {
        try (InputStream in = input) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] block = new byte[8192];
            for (int n; (n = in.read(block)) != -1; ) {
                if (out.size() + n > limit) throw new IOException("Voice manifest too large");
                out.write(block, 0, n);
            }
            return out.toByteArray();
        }
    }

    static String sha256(File file) throws IOException {
        return sha256(file, 0, file.length());
    }

    /** SHA-256 of {@code length} bytes of {@code file} from {@code offset}. */
    private static String sha256(File file, long offset, long length) throws IOException {
        try (java.io.RandomAccessFile in = new java.io.RandomAccessFile(file, "r")) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] block = new byte[1 << 16];
            in.seek(offset);
            for (long left = length; left > 0; ) {
                int n = in.read(block, 0, (int) Math.min(block.length, left));
                if (n < 0) throw new IOException("Voice asset shorter than manifest");
                digest.update(block, 0, n);
                left -= n;
            }
            StringBuilder hex = new StringBuilder();
            for (byte b : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", b & 255));
            return hex.toString();
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new IOException(error);
        }
    }
}
