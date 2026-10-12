package ai.eliza.kokoro;

import android.content.Context;
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
 * Copies the APK's pinned Kokoro bundle (model, voice preset, eSpeak NG
 * English data) to app storage and checks every file against the SHA-256 in
 * the bundle manifest. It takes no URL or caller path. Run it on a worker.
 */
public final class KokoroAssets {
    public static final String ASSET_ROOT = "kokoro-voice/v1";
    private static final String FORMAT = "eliza-kokoro-voice-v1";

    /** Installed file locations. */
    public static final class Bundle {
        public final File model;
        public final File voice;
        public final File espeakRoot;

        Bundle(File model, File voice, File espeakRoot) {
            this.model = model;
            this.voice = voice;
            this.espeakRoot = espeakRoot;
        }

        public KokoroVoice open() throws IOException {
            return new KokoroVoice(model, voice, espeakRoot);
        }
    }

    private KokoroAssets() {}

    public static synchronized Bundle install(Context context) throws IOException {
        byte[] manifestBytes = read(context.getAssets().open(ASSET_ROOT + "/manifest.json"), 1 << 20);
        JSONObject manifest;
        try {
            manifest = new JSONObject(new String(manifestBytes, StandardCharsets.UTF_8));
            if (!FORMAT.equals(manifest.getString("format"))) throw new IOException("Unsupported Kokoro bundle");
        } catch (org.json.JSONException error) {
            throw new IOException("Invalid Kokoro bundle manifest", error);
        }
        File root = new File(context.getFilesDir(), "kokoro-voice-v1");
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("Kokoro storage unavailable");
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
            return new Bundle(
                    resolve(root, manifest.getString("model")),
                    resolve(root, manifest.getString("voice")),
                    resolve(root, manifest.getString("espeakRoot")));
        } catch (org.json.JSONException error) {
            throw new IOException("Invalid Kokoro bundle manifest", error);
        }
    }

    private static File resolve(File root, String relative) throws IOException {
        File file = new File(root, relative);
        String base = root.getCanonicalPath() + File.separator;
        if (relative.isEmpty() || relative.startsWith("/") || !(file.getCanonicalPath() + File.separator).startsWith(base)) {
            throw new IOException("Invalid Kokoro bundle path");
        }
        return file;
    }

    private static void copy(Context context, String relative, File target, long bytes, String sha)
            throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Kokoro storage unavailable");
        File partial = new File(target.getPath() + ".partial");
        long total = 0;
        try (InputStream in = context.getAssets().open(ASSET_ROOT + "/" + relative);
                OutputStream out = new FileOutputStream(partial)) {
            byte[] block = new byte[1 << 16];
            for (int n; (n = in.read(block)) != -1; ) {
                total += n;
                if (total > bytes) throw new IOException("Kokoro asset larger than manifest: " + relative);
                out.write(block, 0, n);
            }
        }
        if (total != bytes || !sha.equals(sha256(partial))) {
            partial.delete();
            throw new IOException("Kokoro asset checksum mismatch: " + relative);
        }
        if (!partial.renameTo(target)) throw new IOException("Kokoro asset install failed: " + relative);
    }

    private static byte[] read(InputStream input, int limit) throws IOException {
        try (InputStream in = input) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] block = new byte[8192];
            for (int n; (n = in.read(block)) != -1; ) {
                if (out.size() + n > limit) throw new IOException("Kokoro manifest too large");
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
