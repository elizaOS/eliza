package ai.eliza.plugins.browsersurface;

import java.util.Collection;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/**
 * The last check before an intercepting surface sends a main-frame request.
 *
 * <p>{@code shouldOverrideUrlLoading} already holds cross-origin GET navigations, but WebView never
 * calls it for POST form submissions or history moves. {@code shouldInterceptRequest} sees those
 * requests on a network thread before anything is sent. A main-frame request may go out only to
 * the origin of the committed page or to an origin the host approved with {@code navigate()} (or
 * {@code createSurface}'s first address, or the {@code goBack}/{@code goForward} entry). Anything
 * else is answered locally with an empty 204, which ends the navigation without a commit, and is
 * reported to the host. So a blocked host never receives the request at all. A running task the
 * host extended to more origins ({@code setTaskOrigins}) also admits a request from one of its
 * origins to another.
 *
 * <p>Within that rule:
 *
 * <ul>
 *   <li>Upgrade. The https form of an admitted {@code http://host} (both default ports) is
 *       admitted too, so an HSTS or HTTPS-first upgrade of an approved address goes out. A
 *       downgrade, another port or another host is never implied.
 *   <li>Redirects. A main-frame server redirect continues the host's in-flight navigation when
 *       its target is admitted by that navigation's approval ({@link #redirect}); the surface
 *       lets it through without asking the host again. The gate never widens itself for a
 *       redirect: a redirect to any other origin is left to {@code BrowserNavigationPolicy}, which
 *       holds and reports it, and its request gets the 204 if WebView sends it anyway.
 *   <li>Settling. An approval lasts for its navigation, not just its first request: commit does
 *       not consume it, so a restarted or repeated main-frame request of the same navigation still
 *       goes out. It ends when that navigation finishes ({@link #settle} with its address), when it
 *       is held ({@link #settle} with null) or when the host approves its next address.
 *   <li>History. Reload and history moves within the committed origin go out. A move to another
 *       origin goes out only when the host made it ({@code goBack}/{@code goForward} approve their
 *       entry); a page's own {@code history.back()} to an origin it left is held like a POST.
 * </ul>
 *
 * Thread safe; pure JVM.
 */
public final class BrowserMainFrameGate {
  private String committed;
  private final Set<String> approved = new HashSet<>();
  private Set<String> taskOrigins = Collections.emptySet();

  /**
   * Replace the origins of the host's running task. Each entry must already be a canonical origin
   * ({@link BrowserWebOrigin#of}); an empty collection ends the extension. Returns false, changing
   * nothing, for any other entry.
   */
  public synchronized boolean setTaskOrigins(Collection<String> origins) {
    Set<String> next = new HashSet<>();
    for (String origin : origins) {
      if (origin == null || !origin.equals(BrowserWebOrigin.of(origin)) || !origin.startsWith("https://"))
        return false;
      next.add(origin);
    }
    taskOrigins = Collections.unmodifiableSet(next);
    return true;
  }

  /** The current task origins; a page may move between them by itself. */
  public synchronized Set<String> taskOrigins() {
    return taskOrigins;
  }

  /** The https origin a default-port http {@code origin} upgrades to, or null. */
  private static String upgrade(String origin) {
    String host = BrowserWebOrigin.host(origin);
    return host != null && origin.equals("http://" + host) ? "https://" + host : null;
  }

  private static boolean covers(String allowed, String origin) {
    return allowed != null && (allowed.equals(origin) || origin.equals(upgrade(allowed)));
  }

  private boolean pending(String origin) {
    for (String allowed : approved)
      if (covers(allowed, origin))
        return true;
    return false;
  }

  /**
   * The host loads this address itself; its origin may receive the main-frame requests of that
   * navigation. It replaces any earlier approval, whose navigation this load supersedes.
   */
  public synchronized void approve(String url) {
    String origin = BrowserWebOrigin.of(url);
    if (origin == null)
      return;
    approved.clear();
    approved.add(origin);
  }

  /** A main-frame document started for {@code url}; its origin becomes the page's own. */
  public synchronized void commit(String url) {
    String origin = BrowserWebOrigin.of(url);
    if (origin != null)
      committed = origin;
  }

  /** Whether a main-frame redirect to {@code url} continues the host's in-flight navigation. */
  public synchronized boolean redirect(String url) {
    String origin = BrowserWebOrigin.of(url);
    return origin != null && pending(origin);
  }

  /**
   * A main-frame navigation finished at {@code url}: the host's approval ends when that navigation
   * was the approved one. Null means the approved navigation was held and will not finish.
   */
  public synchronized void settle(String url) {
    if (url == null) {
      approved.clear();
      return;
    }
    String origin = BrowserWebOrigin.of(url);
    if (origin != null && pending(origin))
      approved.clear();
  }

  /** Whether a main-frame request for {@code url} may leave the device. */
  public synchronized boolean admit(String url) {
    String origin = BrowserWebOrigin.of(url);
    if (origin == null)
      return false;
    return covers(committed, origin) || pending(origin)
        || (committed != null && taskOrigins.contains(committed) && taskOrigins.contains(origin));
  }
}
