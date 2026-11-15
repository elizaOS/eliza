package ai.eliza.plugins.browsersurface;

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
   * {@code appPage}. A host page without an http(s) origin refuses.
   */
  public static boolean allowed(String page, String appPage) {
    if (page == null || page.length() > MAX_PAGE)
      return false;
    String origin = BrowserWebOrigin.of(page);
    if (origin == null || !origin.startsWith("https://"))
      return false;
    // A missing host page fails closed: the handoff cannot show that it leaves the app.
    String own = BrowserWebOrigin.of(appPage);
    return own != null && !origin.equals(own);
  }

  /** Whether a resolved activity may receive the page. */
  public static boolean eligible(String ownPackage, String packageName, boolean enabled,
      boolean exported, boolean allWebLinks) {
    return packageName != null && !packageName.equals(ownPackage) && enabled && exported
        && allWebLinks;
  }
}
