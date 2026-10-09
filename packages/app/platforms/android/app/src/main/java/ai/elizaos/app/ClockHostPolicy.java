package ai.elizaos.app;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.LinkedHashMap;
import java.util.Map;

/** Closed native origin/path policy; no renderer URL, DNS lookup or credential fallback. */
final class ClockHostPolicy {
    static URI base(String value) {
        URI uri = URI.create(value);
        if (uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                || !uri.normalize().equals(uri) || value.indexOf('\\') >= 0 || uri.getRawPath().contains("%"))
            throw new IllegalArgumentException("Invalid native agent origin");
        String scheme = uri.getScheme(), host = uri.getHost().toLowerCase(Locale.ROOT);
        if (!"https".equals(scheme) && !("http".equals(scheme) && privateHost(host)))
            throw new SecurityException("Native agent requires HTTPS or a private local address");
        return uri;
    }
    private static boolean privateHost(String host) {
        if (host.equals("localhost") || host.equals("[::1]") || host.equals("::1")) return true;
        if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
        if (host.matches("(?:fc|fd)[a-f0-9:]+") || host.matches("fe[89ab][a-f0-9:]+")) return true;
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        for (int i = 0; i < 4; i++) {
            if (!parts[i].matches("0|[1-9][0-9]{0,2}")) return false;
            octets[i] = Integer.parseInt(parts[i]);
            if (octets[i] > 255) return false;
        }
        return octets[0] == 127 || octets[0] == 10 || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
                || (octets[0] == 192 && octets[1] == 168) || (octets[0] == 169 && octets[1] == 254);
    }
    static URI endpoint(URI base, String path) {
        URI relative = URI.create(path);
        if (!path.startsWith("/api/") || relative.isAbsolute() || relative.getRawAuthority() != null
                || relative.getFragment() != null || !relative.normalize().equals(relative)
                || path.indexOf('\\') >= 0 || relative.getRawPath().contains("%"))
            throw new IllegalArgumentException("Invalid native agent path");
        String prefix = base.toString().replaceAll("/+$", "");
        return URI.create(prefix + path);
    }
    static String origin(URI base) {
        int port = base.getPort();
        boolean defaultPort = port == -1 || ("https".equals(base.getScheme()) && port == 443) || ("http".equals(base.getScheme()) && port == 80);
        return base.getScheme() + "://" + base.getHost().toLowerCase(Locale.ROOT) + (defaultPort ? "" : ":" + port);
    }
    static void agentPath(String method, String path) {
        URI relative = URI.create(path);
        String route = relative.getPath();
        if (!relative.normalize().equals(relative) || relative.isAbsolute() || relative.getRawAuthority() != null
                || relative.getFragment() != null || path.indexOf('\\') >= 0 || relative.getRawPath().contains("%"))
            throw new SecurityException("Unsupported native chat path");
        boolean allowed = "GET".equals(method) && (route.equals("/api/conversations")
                || route.matches("/api/conversations/[-A-Za-z0-9_]+/messages"));
        allowed |= "POST".equals(method) && relative.getQuery() == null && (route.equals("/api/conversations")
                || route.matches("/api/conversations/[-A-Za-z0-9_]+/(?:messages(?:/stream)?|greeting)")
                || route.equals("/api/chat"));
        if (!allowed) throw new SecurityException("Unsupported native chat path");
    }
    static void header(String name, String value) {
        String key = name.toLowerCase(Locale.ROOT);
        boolean allowed = key.equals("accept") || key.equals("content-type")
                || key.equals("x-elizaos-client-id") || key.equals("x-elizaos-ui-language")
                || key.equals("x-eliza-last-activity") || key.equals("x-elizaos-turn-correlation")
                || key.equals("x-elizaos-turn-attempt");
        if (!allowed
                || value == null || value.length() > 256 || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0)
            throw new SecurityException("Renderer headers cannot authorize native requests");
    }
    /** Caller credentials may only corroborate the current native owner. Never
     * forward them; the client injects its own snapshotted credentials. */
    static Map<String, String> headers(Map<String, String> supplied, String bearer, String cookie) throws java.io.UnsupportedEncodingException {
        Map<String, String> publicHeaders = new LinkedHashMap<>();
        if (supplied == null) return publicHeaders;
        for (Map.Entry<String, String> entry : supplied.entrySet()) {
            String name = entry.getKey(), value = entry.getValue(), expected = null;
            String key = name.toLowerCase(Locale.ROOT);
            if (key.equals("authorization")) expected = bearer == null ? null : "Bearer " + bearer;
            else if (key.equals("cookie")) expected = cookie == null || cookie.isEmpty() ? null : cookie;
            else if (key.equals("x-eliza-csrf")) expected = csrf(cookie);
            else {
                header(name, value); publicHeaders.put(name, value); continue;
            }
            if (expected == null || value == null || value.length() > 16384
                    || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0 || value.indexOf('\0') >= 0
                    || !MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), value.getBytes(StandardCharsets.UTF_8)))
                throw new SecurityException("Caller does not match the current native authentication");
        }
        return publicHeaders;
    }
    static String csrf(String cookie) throws java.io.UnsupportedEncodingException {
        String result = null;
        if (cookie != null) for (String part : cookie.split(";")) {
            String item = part.trim();
            if (item.startsWith("eliza_csrf=")) result = URLDecoder.decode(item.substring(11), "UTF-8");
        }
        return result == null || result.isEmpty() ? null : result;
    }
    static String hash(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(64);
            for (byte b : bytes) result.append(Character.forDigit((b >>> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
            return result.toString();
        } catch (java.security.NoSuchAlgorithmException error) {
            // error-policy:J2 SHA-256 is a required platform primitive.
            throw new IllegalStateException("Native Clock hash unavailable", error);
        }
    }
}
