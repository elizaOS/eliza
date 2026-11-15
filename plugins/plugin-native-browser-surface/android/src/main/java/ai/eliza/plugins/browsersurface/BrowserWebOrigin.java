package ai.eliza.plugins.browsersurface;

import java.net.URI;
import java.util.Locale;

/**
 * Web origins for browser-surface host policy (downloads, site permissions, clearing).
 *
 * <p>Pure JVM, no Android types, so hosts and tests share exactly one definition. An origin is
 * {@code scheme://host[:port]} for http and https only, lower case, with the scheme's default port
 * elided. Addresses with user info, without a host, with control characters, whitespace or a
 * backslash, or longer than {@link #MAX_URL} have no origin. Anything this class cannot parse has
 * no origin: callers treat {@code null} as "share nothing".
 */
public final class BrowserWebOrigin {
  public static final int MAX_URL = 8192;

  private BrowserWebOrigin() {}

  /** Control characters, whitespace and backslash: browsers strip or rewrite them, so refuse. */
  private static boolean unsafe(String value) {
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      if (c <= 0x20 || c == 0x7f || c == '\\' || Character.isWhitespace(c) || Character.isSpaceChar(c))
        return true;
    }
    return false;
  }

  /**
   * The canonical web origin of {@code url}, or null when it is not an http(s) web address.
   *
   * <p>Only the scheme and authority are read. Path, query and fragment are never parsed, so
   * addresses Chromium reports with {@code | ^ { } [ ]} or a literal {@code %} after the host keep
   * their origin. Any {@code @} in the authority is user info and has no origin.
   */
  public static String of(String url) {
    if (url == null || url.isEmpty() || url.length() > MAX_URL || unsafe(url))
      return null;
    int fragment = url.indexOf('#');
    String address = fragment < 0 ? url : url.substring(0, fragment);
    int colon = address.indexOf(':');
    if (colon < 0 || !address.startsWith("//", colon + 1))
      return null;
    String scheme = address.substring(0, colon).toLowerCase(Locale.ROOT);
    if (!scheme.equals("https") && !scheme.equals("http"))
      return null;
    int start = colon + 3, end = start;
    while (end < address.length() && "/?".indexOf(address.charAt(end)) < 0)
      end++;
    String authority = address.substring(start, end);
    if (authority.isEmpty() || authority.indexOf('@') >= 0)
      return null;
    String host = authority, digits = "";
    int close = authority.startsWith("[") ? authority.indexOf(']') : -1;
    int portAt = authority.indexOf(':', Math.max(close, 0));
    if (authority.startsWith("[") && close < 0)
      return null;
    if (portAt >= 0) {
      host = authority.substring(0, portAt);
      digits = authority.substring(portAt + 1);
    } else if (close >= 0 && close != authority.length() - 1) {
      return null;
    }
    if (host.isEmpty() || digits.length() > 5)
      return null;
    for (int i = 0; i < digits.length(); i++)
      if (digits.charAt(i) < '0' || digits.charAt(i) > '9')
        return null;
    int port = digits.isEmpty() ? -1 : Integer.parseInt(digits);
    if (port > 65535)
      return null;
    try {
      // Validates the host (and IPv6 literal) as a server authority; nothing else is parsed.
      host = new URI(scheme, null, host, port, null, null, null).getHost();
    } catch (Exception invalid) {
      return null;
    }
    if (host == null || host.isEmpty())
      return null;
    boolean standard = port < 0 || (scheme.equals("https") && port == 443)
        || (scheme.equals("http") && port == 80);
    return scheme + "://" + host.toLowerCase(Locale.ROOT) + (standard ? "" : ":" + port);
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
