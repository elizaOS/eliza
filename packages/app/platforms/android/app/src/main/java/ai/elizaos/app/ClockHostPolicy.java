package ai.elizaos.app;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

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
        if (!(name.equalsIgnoreCase("accept") || name.equalsIgnoreCase("content-type"))
                || value == null || value.length() > 256 || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0)
            throw new SecurityException("Renderer headers cannot authorize native requests");
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
