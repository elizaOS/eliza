package ai.eliza.plugins.browsersurface;

import java.net.URI;

/**
 * The exact origin a browser HTTP authentication prompt may be filled or saved for.
 *
 * <p>A provider may fill the prompt only when the <em>browser engine itself</em> reports the
 * challenge ({@link EngineChallenge}): the exact request URL it was answering (after every
 * redirect), the realm, whether the request was the top-level document, and that TLS was
 * validated. The host never builds that report from navigation history, page script or the
 * top-level URL. Android's standard WebView supplies only a host and realm ({@code
 * WebViewClient#onReceivedHttpAuthRequest}), so {@link #STANDARD_WEBVIEW} reports nothing and
 * every prompt is refused with a reason code; manual entry stays available. Anything this class
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

  /**
   * Fill/save is allowed for {@code origin}, or refused: {@code code} names the reason for logs and
   * tests, and {@code refusal} is the one sentence the sign-in dialog shows for every reason.
   */
  public static final class Decision {
    public final String origin, code, refusal;

    private Decision(String origin, String code) {
      this.origin = origin;
      this.code = code;
      this.refusal = code == null ? null : REFUSAL;
    }

    public boolean fillable() {
      return origin != null;
    }
  }

  /** What the sign-in dialog says whenever fill is off, whatever the reason. */
  public static final String REFUSAL =
      "Your password manager can't fill this sign-in. Type the password yourself.";

  /** The engine does not report the exact site address for sign-in prompts (standard WebView). */
  public static final String NO_ENGINE_ORIGIN = "no-engine-origin";
  /** Requested by a frame or resource inside the page, not the page itself. */
  public static final String FRAME = "frame";
  /** The connection is not verified HTTPS. */
  public static final String INSECURE = "insecure";
  /** The engine's report does not match this prompt. */
  public static final String MISMATCH = "mismatch";
  /** The page moved to another address after the request. */
  public static final String REDIRECTED = "redirected";
  /** The challenge belongs to an earlier page load. */
  public static final String STALE = "stale";
  /** The tab is not the one shown. */
  public static final String HIDDEN = "hidden";

  private static Decision refuse(String code) {
    return new Decision(null, code);
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
    return url == null || url.length() > 4096 ? null : BrowserWebOrigin.of(url);
  }
}
