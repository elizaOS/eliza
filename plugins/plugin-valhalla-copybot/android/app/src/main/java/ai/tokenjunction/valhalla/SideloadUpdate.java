package ai.tokenjunction.valhalla;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import org.json.JSONObject;

/** Sideload update. The file is installed only after the SHA-256 matches version.json. */
final class SideloadUpdate {
    static final String VERSION_URL =
            "https://github.com/TokenJunction/eliza-valhalla/releases/latest/download/version.json";

    static final class Offer {
        final String version;
        final String url;
        final String sha256;

        Offer(String version, String url, String sha256) {
            this.version = version;
            this.url = url;
            this.sha256 = sha256;
        }
    }

    static Offer newer(String current) {
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(VERSION_URL).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            if (conn.getResponseCode() != 200) return null;
            String raw = new String(conn.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            JSONObject doc = new JSONObject(raw);
            String version = doc.optString("version", current);
            if (!isNewer(current, version)) return null;
            JSONObject android = doc.optJSONObject("android");
            if (android == null) return null;
            String sha = android.optString("sha256", "");
            String url = android.optString("url", "");
            if (sha.length() != 64 || !url.startsWith("https://github.com/TokenJunction/eliza-valhalla/")) return null;
            return new Offer(version, url, sha);
        } catch (Exception err) {
            return null;
        }
    }

    static boolean install(Activity activity, Offer offer) {
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(offer.url).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(60000);
            if (conn.getResponseCode() != 200) return false;
            byte[] bytes = conn.getInputStream().readAllBytes();
            String actual = sha256(bytes);
            if (!actual.equalsIgnoreCase(offer.sha256)) return false;
            File dir = new File(activity.getCacheDir(), "updates");
            if (!dir.isDirectory() && !dir.mkdirs()) return false;
            File apk = new File(dir, "valhalla-phone.apk");
            try (FileOutputStream out = new FileOutputStream(apk)) {
                out.write(bytes);
            }
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
            return true;
        } catch (Exception err) {
            return false;
        }
    }

    static boolean isNewer(String current, String latest) {
        String[] left = current.replaceFirst("(?i)^v", "").split("[.-]");
        String[] right = latest.replaceFirst("(?i)^v", "").split("[.-]");
        for (int i = 0; i < 3; i++) {
            int a = i < left.length ? parse(left[i]) : 0;
            int b = i < right.length ? parse(right[i]) : 0;
            if (b > a) return true;
            if (b < a) return false;
        }
        return false;
    }

    private static int parse(String part) {
        try {
            return Integer.parseInt(part.replaceAll("[^0-9]", ""));
        } catch (Exception err) {
            return 0;
        }
    }

    private static String sha256(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder out = new StringBuilder();
        for (byte value : digest) out.append(String.format("%02x", value));
        return out.toString();
    }
}
