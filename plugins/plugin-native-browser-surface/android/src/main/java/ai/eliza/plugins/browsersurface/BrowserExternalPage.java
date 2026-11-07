package ai.eliza.plugins.browsersurface;

import java.net.URI;

/**
 * Admission for an explicit, reviewed handoff of the visible page to another installed browser.
 * Only the address leaves: no cookies, form data or page content. The page must be HTTPS without
 * embedded credentials and must not be the host app's own origin; the receiving app must be
 * another package whose enabled, exported activity handles every HTTPS link (a general browser,
 * not a deep-link handler for one site). Plain Java: host-tested by javac.
 */
public final class BrowserExternalPage {
  public static final int MAX_PAGE = 4096;

  private BrowserExternalPage() {}

  /**
   * Whether {@code page} may be handed to another browser from a host whose own page is
   * {@code appPage}. A missing or malformed host page refuses.
   */
  public static boolean allowed(String page, String appPage) {
    try {
      if (page == null || page.length() > MAX_PAGE || page.indexOf('\\') >= 0
          || page.chars().anyMatch(c -> c <= 32 || c == 127)) return false;
      URI url = new URI(page);
      if (!"https".equalsIgnoreCase(url.getScheme()) || url.getHost() == null
          || url.getRawUserInfo() != null) return false;
      // A missing host page fails closed: the handoff cannot show that it leaves the app.
      URI host = new URI(appPage);
      return !(url.getHost().equalsIgnoreCase(host.getHost()) && port(url) == port(host)
          && url.getScheme().equalsIgnoreCase(host.getScheme()));
    } catch (Exception invalid) {
      return false;
    }
  }

  private static int port(URI url) {
    return url.getPort() < 0 ? ("https".equalsIgnoreCase(url.getScheme()) ? 443 : 80) : url.getPort();
  }

  /** Whether a resolved activity may receive the page. */
  public static boolean eligible(String ownPackage, String packageName, boolean enabled,
      boolean exported, boolean allWebLinks) {
    return packageName != null && !packageName.equals(ownPackage) && enabled && exported
        && allWebLinks;
  }
}
