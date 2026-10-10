package ai.eliza.plugins.browsersurface;

import java.net.URI;
import java.util.Locale;

/**
 * Web origins for browser-surface host policy (downloads, site permissions, clearing).
 *
 * <p>Pure JVM, no Android types, so hosts and tests share exactly one definition. An origin is
 * {@code scheme://host[:port]} for http and https only, lower case, with the scheme's default port
 * elided. Addresses with user info, without a host, with control characters or longer than
 * {@link #MAX_URL} have no origin. Anything this class cannot parse has no origin: callers treat
 * {@code null} as "share nothing".
 */
public final class BrowserWebOrigin {
  public static final int MAX_URL = 8192;

  private BrowserWebOrigin() {}

  private static boolean controls(String value) {
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      if (c <= 0x1f || c == 0x7f)
        return true;
    }
    return false;
  }

  /** The canonical web origin of {@code url}, or null when it is not an http(s) web address. */
  public static String of(String url) {
    if (url == null || url.isEmpty() || url.length() > MAX_URL || controls(url))
      return null;
    try {
      URI uri = new URI(url);
      String scheme = uri.getScheme(), host = uri.getHost();
      if (scheme == null || host == null || host.isEmpty() || uri.getRawUserInfo() != null)
        return null;
      scheme = scheme.toLowerCase(Locale.ROOT);
      if (!scheme.equals("https") && !scheme.equals("http"))
        return null;
      int port = uri.getPort();
      if (port > 65535)
        return null;
      boolean standard = port < 0 || (scheme.equals("https") && port == 443)
          || (scheme.equals("http") && port == 80);
      return scheme + "://" + host.toLowerCase(Locale.ROOT) + (standard ? "" : ":" + port);
    } catch (Exception invalid) {
      return null;
    }
  }

  /** {@code blob:https://host/uuid} belongs to its embedded origin; anything else has none. */
  public static String blobOwner(String url) {
    if (url == null || !url.regionMatches(true, 0, "blob:", 0, 5))
      return null;
    return of(url.substring(5));
  }

  /** True only when both addresses have the same non-null origin. */
  public static boolean sameOrigin(String a, String b) {
    String left = of(a);
    return left != null && left.equals(of(b));
  }

  /** The host of a canonical origin (brackets kept for IPv6), or null. */
  public static String host(String origin) {
    String canonical = of(origin);
    if (canonical == null)
      return null;
    String rest = canonical.substring(canonical.indexOf("://") + 3);
    if (rest.startsWith("["))
      return rest.substring(0, rest.indexOf(']') + 1);
    int colon = rest.lastIndexOf(':');
    return colon < 0 ? rest : rest.substring(0, colon);
  }

  /**
   * "Clear data for this site": true when the origin's host is {@code site} or one of its
   * subdomains. {@code site} is a host name supplied by the host's own clearing UI.
   */
  public static boolean withinSite(String origin, String site) {
    if (site == null || site.isEmpty())
      return false;
    String host = host(origin), domain = site.toLowerCase(Locale.ROOT);
    return host != null && (host.equals(domain) || host.endsWith("." + domain));
  }
}
