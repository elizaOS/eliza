package ai.eliza.plugins.browsersurface;

/**
 * Which main-frame callbacks of a tab describe the document it shows. Pure JVM.
 *
 * <p>WebView reports a cross-document load as onPageStarted, then commit, then onPageCommitVisible
 * and onPageFinished. A same-document move (history.pushState, a #fragment, Back or Forward between
 * such entries) reports only doUpdateVisitedHistory. A page may also rewrite its own address
 * (history.replaceState in its head) before first paint, so the commit callbacks then name the
 * requested address while the engine already shows the rewritten one.
 */
public final class BrowserDocumentCommit {
  private BrowserDocumentCommit() {}

  /**
   * Whether a doUpdateVisitedHistory for {@code url} is a same-document commit of the tab's
   * committed page: not a reload, no cross-document load started since the last commit, the tab
   * is live without an error, the engine shows {@code url}, and it stays at the committed origin.
   */
  public static boolean sameDocument(String url, String engineUrl, boolean reload, boolean started,
      boolean dead, String error, String lastCommittedUrl) {
    return !reload && !started && !dead && (error == null || error.isEmpty()) && url != null
        && url.equals(engineUrl) && BrowserWebOrigin.sameOrigin(url, lastCommittedUrl);
  }

  /**
   * The address a commit callback for {@code url} adopts, or null when the callback is not for
   * the tab's current load. The engine's address is adopted when it equals {@code url}, or when
   * {@code url} is the load this tab started and the engine shows a same-origin rewrite of it
   * (and no later main-frame request replaced that load).
   */
  public static String committedUrl(String url, String engineUrl, String startedUrl, String pendingMain) {
    if (url == null || engineUrl == null)
      return null;
    if (url.equals(engineUrl))
      return engineUrl;
    if (!url.equals(startedUrl) || (pendingMain != null && !url.equals(pendingMain)))
      return null;
    return BrowserWebOrigin.sameOrigin(url, engineUrl) ? engineUrl : null;
  }

  /**
   * Whether a TLS error for {@code errorUrl} belongs to the main document: the pending main-frame
   * request, or the tab's address before anything committed. A subresource error is only refused.
   */
  public static boolean mainResource(String errorUrl, String pendingMain, String url, boolean committed) {
    if (errorUrl == null)
      return false;
    return errorUrl.equals(pendingMain) || (!committed && errorUrl.equals(url));
  }
}
