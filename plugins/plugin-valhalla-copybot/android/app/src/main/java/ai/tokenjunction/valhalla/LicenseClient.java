package ai.tokenjunction.valhalla;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/** Public Lemon Squeezy license calls. There is no API secret in this app. */
final class LicenseClient {
    static final String ACTIVATE = "https://api.lemonsqueezy.com/v1/licenses/activate";
    static final String VALIDATE = "https://api.lemonsqueezy.com/v1/licenses/validate";

    static final class Result {
        final boolean ok;
        final boolean down;
        final String instanceId;

        Result(boolean ok, boolean down, String instanceId) {
            this.ok = ok;
            this.down = down;
            this.instanceId = instanceId == null ? "" : instanceId;
        }
    }

    static Result activate(String key) {
        return post(ACTIVATE, "license_key=" + enc(key) + "&instance_name=" + enc("valhalla-phone"));
    }

    static Result validate(String key, String instanceId) {
        return post(VALIDATE, "license_key=" + enc(key) + "&instance_id=" + enc(instanceId));
    }

    private static Result post(String endpoint, String form) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(endpoint).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            byte[] bytes = form.getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(bytes);
            }
            int status = conn.getResponseCode();
            String body = read(conn, status);
            if (status >= 500) return new Result(false, true, "");
            boolean active = body.contains("\"status\":\"active\"")
                    && (body.contains("\"activated\":true") || body.contains("\"valid\":true"))
                    && (body.contains("\"product_id\":1498767") || body.contains("\"product_id\": 1498767"));
            if (!active) return new Result(false, false, "");
            return new Result(true, false, instanceId(body));
        } catch (Exception err) {
            return new Result(false, true, "");
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String read(HttpURLConnection conn, int status) {
        try {
            java.io.InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (stream == null) return "";
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        } catch (Exception err) {
            return "";
        }
    }

    private static String instanceId(String body) {
        int at = body.indexOf("\"id\":\"");
        if (at < 0) return "";
        int start = at + 6;
        int end = body.indexOf('"', start);
        if (end < 0) return "";
        return body.substring(start, end);
    }

    private static String enc(String value) {
        return URLEncoder.encode(value == null ? "" : value, StandardCharsets.UTF_8);
    }
}
