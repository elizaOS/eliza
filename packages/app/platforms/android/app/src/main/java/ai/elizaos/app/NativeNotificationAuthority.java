package ai.elizaos.app;

import ai.eliza.plugins.securestore.nativeonly.NativeSecureStore;
import android.content.Context;
import android.webkit.CookieManager;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import okhttp3.Request;
import org.json.JSONObject;

/** Native-only profile custody. A socket or HTTP response never outlives its
 * credential snapshot; neither credentials nor records pass through JS. */
final class NativeNotificationAuthority {
    final NativeSecureStore store;
    final NativeSecureStore.Snapshot snapshot;
    final URI base;
    final String owner;
    private final String bearer, cookie;

    NativeNotificationAuthority(Context context) throws Exception {
        store = new NativeSecureStore(context);
        snapshot = store.snapshot();
        JSONObject profile = new JSONObject(snapshot.require("runtime.active_server"));
        String kind = profile.getString("kind");
        if (!"remote".equals(kind) && !"cloud".equals(kind))
            throw new SecurityException("Remote notification profile required");
        // The existing native trust grammar permits HTTPS or private HTTP and
        // rejects credential-bearing/ambiguous URLs. No Clock enrollment used.
        base = ClockHostPolicy.base(profile.getString("apiBase"));
        bearer = profile.optString("accessToken", "");
        cookie = currentCookie();
        if (bearer.isEmpty() && cookie.isEmpty())
            throw new SecurityException("Native notification authentication unavailable");
        if (bearer.length() > 8192 || bearer.indexOf('\r') >= 0 || bearer.indexOf('\n') >= 0)
            throw new SecurityException("Invalid native notification authentication");
        owner = digest(new JSONObject().put("id", profile.getString("id"))
            .put("kind", kind).put("base", base.toString()).put("bearer", bearer).put("cookie", cookie).toString());
        current();
    }

    String url(String path) {
        if (!"/ws".equals(path) && !"/api/notifications".equals(path))
            throw new SecurityException("Notification route unavailable");
        return base.toString().replaceAll("/+$", "") + path;
    }

    Request request(String path) throws Exception {
        current();
        Request.Builder request = new Request.Builder().url(url(path)).get();
        if (!bearer.isEmpty()) request.header("Authorization", "Bearer " + bearer);
        if (!cookie.isEmpty()) request.header("Cookie", cookie);
        request.header("Accept", "application/json");
        return request.build();
    }

    void current() throws Exception {
        store.assertCurrent(snapshot);
        if (!cookie.equals(currentCookie()))
            throw new SecurityException("Native notification cookie changed");
    }

    private String currentCookie() {
        String value = CookieManager.getInstance().getCookie(base.toString());
        if (value == null) return "";
        if (value.length() > 16384 || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0)
            throw new SecurityException("Invalid native notification cookie");
        return value;
    }

    private static String digest(String value) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder(64);
        for (byte b : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return result.toString();
    }
}
