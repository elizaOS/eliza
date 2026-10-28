package ai.eliza.voice;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
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
 * misaki lexicon and the optional eSpeak NG English data; {@code asr/} holds the
 * Phonon-2 GGUF when the bundle carries one. The host chooses a private directory
 * beneath filesDir; no renderer path or URL is accepted. Run it on a worker thread.
 * This installer never loads a native library or opens a model context.
 */
public final class VoiceBundleAssets {
    public static final String ASSET_ROOT = "paradee-voice/v1";
    private static final String FORMAT = "eliza-paradee-voice-v1";
    public static final String DIRECTORY_METADATA = "ai.eliza.voice.BUNDLE_DIRECTORY";

    /** Installed file locations. */
    public static final class Installation {
        /** Installed model root; the host owns any native model session. */
        public final File root;
        public final File model;
        public final File lexicon;
        /** Directory that contains {@code espeak-ng-data}, or null. */
        public final File espeakDir;

        Installation(File root, File model, File lexicon, File espeakDir) {
            this.root = root;
            this.model = model;
            this.lexicon = lexicon;
            this.espeakDir = espeakDir;
        }

    }

    private VoiceBundleAssets() {}

    /** Product storage identity; the default preserves existing downstream installations. */
    public static File bundleRoot(Context context) throws IOException {
        String directory = "paradee-voice-v1";
        try {
            ApplicationInfo info = context.getPackageManager().getApplicationInfo(context.getPackageName(), PackageManager.GET_META_DATA);
            if (info.metaData != null && info.metaData.containsKey(DIRECTORY_METADATA)) {
                Object value = info.metaData.get(DIRECTORY_METADATA);
                if (!(value instanceof String)) throw new IOException("Invalid voice storage identity");
                directory = (String) value;
            }
        } catch (PackageManager.NameNotFoundException error) {
            throw new IOException("Voice storage identity unavailable", error);
        }
        return resolve(context.getFilesDir(), directory);
    }

    /** Absence is allowed in explicit cloud/host-test packages; malformed present bundles still fail. */
    public static boolean isPackaged(Context context) throws IOException {
        String[] names = context.getAssets().list(ASSET_ROOT);
        return names != null && Arrays.asList(names).contains("manifest.json");
    }

    public static Installation install(Context context) throws IOException {
        return install(context, bundleRoot(context));
    }

    private static synchronized Installation install(Context context, File root) throws IOException {
        byte[] manifestBytes = read(context.getAssets().open(ASSET_ROOT + "/manifest.json"), 1 << 20);
        JSONObject manifest;
        try {
            manifest = new JSONObject(new String(manifestBytes, StandardCharsets.UTF_8));
            if (!FORMAT.equals(manifest.getString("format"))) throw new IOException("Unsupported voice bundle");
        } catch (org.json.JSONException error) {
            throw new IOException("Invalid voice bundle manifest", error);
        }
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("Voice storage unavailable");
        File stamp = new File(root, "installed-manifest.json");
        boolean verified = stamp.isFile() && Arrays.equals(read(new FileInputStream(stamp), 1 << 20), manifestBytes);
        try {
            JSONArray files = manifest.getJSONArray("files");
            for (int i = 0; i < files.length(); i++) {
                JSONObject entry = files.getJSONObject(i);
                File target = resolve(root, entry.getString("path"));
                long bytes = entry.getLong("bytes");
                // A matching stamp means every file was hashed after the last copy.
                if (verified && target.length() == bytes) continue;
                String sha = entry.getString("sha256");
                if (target.isFile() && target.length() == bytes && sha.equals(sha256(target))) continue;
                copy(context, entry.getString("path"), target, bytes, sha);
            }
            try (OutputStream out = new FileOutputStream(stamp)) {
                out.write(manifestBytes);
            }
            String espeak = manifest.optString("espeakDir", "");
            return new Installation(
                    root,
                    resolve(root, manifest.getString("model")),
                    resolve(root, manifest.getString("lexicon")),
                    espeak.isEmpty() ? null : resolve(root, espeak));
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
        try (InputStream in = new FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] block = new byte[1 << 16];
            for (int n; (n = in.read(block)) != -1; ) digest.update(block, 0, n);
            StringBuilder hex = new StringBuilder();
            for (byte b : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", b & 255));
            return hex.toString();
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new IOException(error);
        }
    }
}
