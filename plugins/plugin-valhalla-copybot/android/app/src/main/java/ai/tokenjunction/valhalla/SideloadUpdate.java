package ai.tokenjunction.valhalla;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;
import java.io.OutputStream;
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
        if (BuildConfig.STORE_BILLING) return null;
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
        if (BuildConfig.STORE_BILLING) return false;
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(offer.url).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(60000);
            if (conn.getResponseCode() != 200) return false;
            byte[] bytes = conn.getInputStream().readAllBytes();
            if (!sha256(bytes).equalsIgnoreCase(offer.sha256)) return false;
            PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setSize(bytes.length);
            int sessionId = installer.createSession(params);
            try (PackageInstaller.Session session = installer.openSession(sessionId)) {
                try (OutputStream out = session.openWrite("valhalla.apk", 0, bytes.length)) {
                    out.write(bytes);
                    session.fsync(out);
                }
                Intent callback = new Intent(activity, activity.getClass());
                int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
                PendingIntent pending = PendingIntent.getActivity(activity, sessionId, callback, flags);
                session.commit(pending.getIntentSender());
            }
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
