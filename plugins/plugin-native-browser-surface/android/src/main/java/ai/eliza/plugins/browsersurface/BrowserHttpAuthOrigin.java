package ai.eliza.plugins.browsersurface;

import java.net.URI;
import java.util.Locale;

/**
 * The exact origin a browser HTTP authentication prompt may be filled or saved for.
 *
 * <p>A provider may fill the prompt only when the <em>browser engine itself</em> reports the
 * challenge ({@link EngineChallenge}): the exact request URL it was answering (after every
 * redirect), the realm, whether the request was the top-level document, and that TLS was
 * validated. The host never builds that report from navigation history, page script or the
 * top-level URL. Android's standard WebView supplies only a host and realm ({@code
 * WebViewClient#onReceivedHttpAuthRequest}), so {@link #STANDARD_WEBVIEW} reports nothing and
 * every prompt is refused with a stated reason; manual entry stays available. Anything this class
 * cannot parse fails closed. Pure JVM; no Android types.
 */
public final class BrowserHttpAuthOrigin {
  private BrowserHttpAuthOrigin() {}

  /** What the browser engine authenticated about one HTTP authentication challenge. */
  public static final class EngineChallenge {
    /** Exact URL of the request the server challenged, after redirects, as the engine sent it. */
    public final String requestUrl;
    /** Realm parsed by the engine from the challenge. */
    public final String realm;
    /** The challenged request is the tab's top-level document (not a frame, worker or resource). */
    public final boolean topLevel;
    /** The response arrived over a TLS connection the engine validated without any override. */
    public final boolean tlsValidated;
    /** The tab navigation generation the engine attributes the request to. */
    public final long navigation;

    public EngineChallenge(String requestUrl, String realm, boolean topLevel, boolean tlsValidated,
        long navigation) {
      this.requestUrl = requestUrl;
      this.realm = realm;
      this.topLevel = topLevel;
      this.tlsValidated = tlsValidated;
      this.navigation = navigation;
    }
  }

  /** The engine's report for a challenge, or null when the engine cannot authenticate one. */
  public interface EngineChallengeSource {
    EngineChallenge challenge(String reportedHost, String reportedRealm);
  }

  /** Android's standard WebView: the challenge callback carries host and realm only. */
  public static final EngineChallengeSource STANDARD_WEBVIEW = (reportedHost, reportedRealm) -> null;

  /** The tab that received the challenge, as the browser host sees it at that moment. */
  public static final class TabSnapshot {
    public String reportedHost, reportedRealm, pendingMain, error = "";
    public boolean selected, shown, paused, closed, otherPrompt;
    public long navigation;
  }

  /** Fill/save is allowed for {@code origin}, or refused with a user-readable {@code refusal}. */
  public static final class Decision {
    public final String origin, refusal;

    private Decision(String origin, String refusal) {
      this.origin = origin;
      this.refusal = refusal;
    }

    public boolean fillable() {
      return origin != null;
    }
  }

  public static final String NO_ENGINE_ORIGIN =
      "Password manager fill is off for this sign-in: the browser engine does not report the exact site address for sign-in prompts. Type the password yourself.";
  public static final String FRAME =
      "Password manager fill is off for this sign-in: it was requested by a frame or resource inside the page, not the page itself.";
  public static final String INSECURE =
      "Password manager fill is off for this sign-in: the connection is not verified HTTPS.";
  public static final String MISMATCH =
      "Password manager fill is off for this sign-in: the browser engine's report does not match this prompt.";
  public static final String REDIRECTED =
      "Password manager fill is off for this sign-in: the page moved to another address after the request.";
  public static final String STALE =
      "Password manager fill is off for this sign-in: it belongs to an earlier page load.";
  public static final String HIDDEN =
      "Password manager fill is off for this sign-in: the tab is not the one shown.";

  private static Decision refuse(String why) {
    return new Decision(null, why);
  }

  /**
   * Decide whether the HTTP sign-in prompt may expose an origin to fill/save providers. Every
   * condition must hold; the first failing one is reported.
   */
  public static Decision bind(EngineChallenge engine, TabSnapshot tab) {
    if (tab == null || tab.closed || tab.paused || !tab.selected || !tab.shown || tab.otherPrompt
        || (tab.error != null && !tab.error.isEmpty()))
      return refuse(HIDDEN);
    if (engine == null)
      return refuse(NO_ENGINE_ORIGIN);
    if (!engine.topLevel)
      return refuse(FRAME);
    String origin = requestOrigin(engine.requestUrl);
    if (origin == null)
      return refuse(MISMATCH);
    if (!origin.startsWith("https://") || !engine.tlsValidated)
      return refuse(INSECURE);
    if (engine.navigation != tab.navigation)
      return refuse(STALE);
    // The WebView callback's host[:port] and realm must describe the same challenge.
    if (!sameAuthority(tab.reportedHost, origin) || engine.realm == null
        || !engine.realm.equals(tab.reportedRealm))
      return refuse(MISMATCH);
    // The engine's request is the authority; the observed main-frame target is only a consistency
    // check that can refuse (a later redirect), never establish, the origin.
    String pending = requestOrigin(tab.pendingMain);
    if (pending == null || !pending.equals(origin))
      return refuse(REDIRECTED);
    return new Decision(origin, null);
  }

  /** {@code host} or {@code host:port} reported by WebView agrees with the origin's host and port. */
  private static boolean sameAuthority(String reported, String origin) {
    if (reported == null || reported.isEmpty())
      return false;
    String reportedOrigin = requestOrigin("https://" + reported + "/");
    if (reportedOrigin == null)
      return false;
    URI exact = URI.create(origin), asked = URI.create(reportedOrigin);
    if (!exact.getHost().equals(asked.getHost()))
      return false;
    // A bare host carries no port, so only an explicit port is compared.
    return asked.getPort() == -1 && !reported.contains(":") || port(exact) == port(asked);
  }

  private static int port(URI uri) {
    return uri.getPort() == -1 ? 443 : uri.getPort();
  }

  /**
   * A bound prompt. It is revoked when the prompt closes for any reason (cancel, dismissal,
   * repeated challenge, tab change, navigation, process loss); after that, and whenever the tab is
   * closed, deselected or has navigated, no structure or late fill value is accepted. Pausing alone
   * does not revoke: the provider's own unlock Activity pauses the host while the prompt stays
   * open, and its result can arrive before the host resumes. Binding required a shown, resumed tab
   * when it was made.
   */
  public static final class Binding {
    public final String origin;
    public final long navigation;
    private volatile boolean live = true, submitted;

    public Binding(String origin, long navigation) {
      this.origin = origin;
      this.navigation = navigation;
    }

    public void revoke() {
      live = false;
    }

    /**
     * The user pressed Sign in: the site's answer is a newer navigation of the same tab, which the
     * host resolves (Save only when it commits at {@link #origin}) or dismisses, revoking this
     * binding.
     */
    public void submitted() {
      submitted = true;
    }

    public boolean admits(TabSnapshot now) {
      return live && now != null && !now.closed && now.selected
          && (now.navigation == navigation || submitted && now.navigation > navigation);
    }
  }

  /** Exact {@code https://host[:port]} of a URL without user info, or null. Default port omitted. */
  public static String exactHttps(String url) {
    String origin = requestOrigin(url);
    return origin != null && origin.startsWith("https://") ? origin : null;
  }

  /** Exact {@code scheme://host[:port]} of an http(s) URL without user info, default port omitted, or null. */
  public static String requestOrigin(String url) {
    if (url == null || url.isEmpty() || url.length() > 4096)
      return null;
    URI uri;
    try {
      uri = new URI(url);
    } catch (Exception invalid) {
      return null;
    }
    String scheme = uri.getScheme() == null ? null : uri.getScheme().toLowerCase(Locale.ROOT);
    String host = uri.getHost();
    if (!("https".equals(scheme) || "http".equals(scheme)) || host == null || host.isEmpty()
        || uri.getRawUserInfo() != null)
      return null;
    int port = uri.getPort();
    boolean defaultPort = port == -1 || ("https".equals(scheme) && port == 443)
        || ("http".equals(scheme) && port == 80);
    return scheme + "://" + host.toLowerCase(Locale.ROOT) + (defaultPort ? "" : ":" + port);
  }
}
