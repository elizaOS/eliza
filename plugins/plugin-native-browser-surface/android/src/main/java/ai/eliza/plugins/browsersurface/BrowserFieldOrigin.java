package ai.eliza.plugins.browsersurface;

import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.util.Objects;

/**
 * The exact origin a website login field in a browser-surface tab may be filled or saved for.
 *
 * <p>The origin comes only from the browser engine: {@code WebViewCompat.WebMessageListener}
 * delivers each message with the {@code sourceOrigin} and {@code isMainFrame} of the frame that
 * posted it, supplied by WebView rather than by any script ({@link EngineSource}). The message
 * itself ({@link Report}) says only which fields of that frame are login fields; it has no origin,
 * frame or address field, so neither page script nor the injected reporter can name one. The
 * reporter runs in an isolated JavaScript world that page script cannot reach ({@link
 * BrowserLoginFields}).
 *
 * <p>A field is bound only when its frame's engine-reported origin is committed HTTPS and equals
 * the tab's committed top-level origin (scheme, host and port), on the selected, shown, resumed,
 * finished tab with no site prompt open. A binding holds only for the navigation it was made in
 * ({@link Binding#admits}). The top-level document and same-origin frames qualify; a frame of any
 * other origin, an opaque (sandboxed) origin or cleartext is refused. Anything this class cannot
 * parse fails closed. Pure JVM; no Android types.
 */
public final class BrowserFieldOrigin {
  private BrowserFieldOrigin() {}

  /** What WebView itself reported about the frame that posted a message. Never page content. */
  public static final class EngineSource {
    /** {@code sourceOrigin} from {@code WebMessageListener#onPostMessage}, as a string. */
    public final String sourceOrigin;
    /** {@code isMainFrame} from {@code WebMessageListener#onPostMessage}. */
    public final boolean mainFrame;

    public EngineSource(String sourceOrigin, boolean mainFrame) {
      this.sourceOrigin = sourceOrigin;
      this.mainFrame = mainFrame;
    }
  }

  /** The tab as the browser host sees it now. */
  public static final class TabSnapshot {
    /** The WebView supports engine-attested messages from an isolated world. */
    public boolean supported;
    /** Autofill eligibility facts; {@code documentUrl} is the committed address. */
    public BrowserAutofillEligibility.TabState state;
    /** The host's navigation generation for this tab. */
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

  public static final String UNSUPPORTED =
      "Password manager fill is off in this browser: this Android System WebView cannot report which site owns a login field. Update Android System WebView.";
  public static final String HIDDEN =
      "Password manager fill is off: the page is not the one shown, or it is still loading.";
  public static final String NO_ORIGIN =
      "Password manager fill is off for this field: the browser engine reported no site for it.";
  public static final String INSECURE =
      "Password manager fill is off for this field: it is not on a verified HTTPS page.";
  public static final String FRAME =
      "Password manager fill is off for this field: it belongs to an embedded frame from another site.";
  public static final String MISMATCH =
      "Password manager fill is off for this field: the browser engine's site does not match this page.";

  private static Decision refuse(String why) {
    return new Decision(null, why);
  }

  /** Exact {@code https://host[:port]}, default port omitted, or null. */
  public static String exactHttps(String url) {
    String origin = BrowserWebOrigin.of(url);
    return origin != null && origin.startsWith("https://") ? origin : null;
  }

  /**
   * Decide whether fields reported with {@code engine} may be offered to the password manager.
   * Every condition must hold; the first failing one is reported.
   */
  public static Decision bind(EngineSource engine, TabSnapshot tab) {
    if (tab == null || !tab.supported)
      return refuse(UNSUPPORTED);
    if (!BrowserAutofillEligibility.eligible(tab.state))
      return refuse(HIDDEN);
    if (engine == null || engine.sourceOrigin == null)
      return refuse(NO_ORIGIN);
    String origin = exactHttps(engine.sourceOrigin);
    if (origin == null)
      return refuse(BrowserWebOrigin.of(engine.sourceOrigin) != null ? INSECURE : NO_ORIGIN);
    String top = exactHttps(tab.state.documentUrl);
    if (top == null)
      return refuse(INSECURE);
    if (!origin.equals(top))
      return refuse(engine.mainFrame ? MISMATCH : FRAME);
    return new Decision(origin, null);
  }

  /**
   * Fields of one frame bound to an engine-reported origin. Revoked by the host on navigation, tab
   * change, overlay, error, close, renderer loss or a later focus elsewhere; after that, or whenever
   * the tab no longer qualifies, no structure is offered and late fill values are dropped. Pausing
   * (a provider's own unlock screen) makes the tab ineligible until it resumes, so values are
   * delivered only to the resumed, shown tab.
   */
  public static final class Binding {
    public final String origin, document;
    public final long navigation;
    public final Report fields;
    private volatile boolean live = true;

    public Binding(String origin, long navigation, Report fields) {
      this.origin = origin;
      this.navigation = navigation;
      this.fields = fields;
      this.document = fields.document;
    }

    public void revoke() {
      live = false;
    }

    public boolean live() {
      return live;
    }

    public boolean admits(TabSnapshot now) {
      return live && now != null && now.supported && now.navigation == navigation
          && BrowserAutofillEligibility.eligible(now.state)
          && origin.equals(exactHttps(now.state.documentUrl));
    }

    /** A later message from the same frame document (same engine origin and script document id). */
    public boolean sameFrame(EngineSource engine, Report report) {
      return live && engine != null && report != null
          && origin.equals(exactHttps(engine.sourceOrigin)) && document.equals(report.document);
    }

    /**
     * The same document's same username and password fields: a re-focus (for example after a
     * provider's unlock screen), not a new form.
     */
    public boolean sameFields(EngineSource engine, Report report) {
      return sameFrame(engine, report) && report.kind == Kind.FOCUS
          && report.username == fields.username && report.password == fields.password;
    }
  }

  /**
   * A focus report refused only because the tab was not eligible yet ({@link #HIDDEN}: still
   * loading, a site prompt open, not shown or paused). Login pages commonly focus a field on load,
   * before the load finishes, and the reporter does not report a field again while it stays
   * focused. The report is kept for the navigation it arrived in and re-run through {@link #bind}
   * in full when the tab becomes eligible; every other refusal is final. Keeping it grants
   * nothing: only a later successful {@code bind} creates a {@link Binding}.
   */
  public static final class Deferred {
    public final EngineSource engine;
    public final Report report;
    public final long navigation;

    private Deferred(EngineSource engine, Report report, long navigation) {
      this.engine = engine;
      this.report = report;
      this.navigation = navigation;
    }

    /** The report to retry, or null when the refusal is not a wait for eligibility. */
    public static Deferred of(EngineSource engine, Report report, TabSnapshot tab, Decision decision) {
      if (engine == null || report == null || report.kind != Kind.FOCUS || tab == null
          || !tab.supported || decision == null || decision.fillable())
        return null;
      return HIDDEN.equals(decision.refusal) ? new Deferred(engine, report, tab.navigation) : null;
    }

    /** A later message from the same frame document (same engine source and script document id). */
    public boolean sameFrame(EngineSource other, Report message) {
      return other != null && message != null
          && Objects.equals(engine.sourceOrigin, other.sourceOrigin)
          && engine.mainFrame == other.mainFrame && report.document.equals(message.document);
    }

    /** Still the navigation the report arrived in; a later document never inherits it. */
    public boolean current(TabSnapshot now) {
      return now != null && now.navigation == navigation;
    }
  }

  public enum Kind { FOCUS, BLUR, GONE, SUBMIT }

  /**
   * One message from the isolated-world reporter ({@code BrowserLoginFields.SCRIPT}). Grammar
   * (nothing else is accepted):
   *
   * <pre>
   * focus|DOC|FOCUSED|USERNAME|PASSWORD|USERNAME_AC|PASSWORD_AC|x,y,w,h,viewportWidth
   * blur|DOC
   * gone|DOC
   * submit|DOC|USERNAME|PASSWORD|encodedUsername|encodedPassword
   * </pre>
   *
   * DOC is the reporter's random per-document id; keys are its small positive field numbers
   * (USERNAME may be 0 for none). Values are percent-encoded. There is no origin, URL or frame
   * field: the origin is {@link EngineSource}'s alone.
   */
  public static final class Report {
    public static final int MAX_MESSAGE = 24576, MAX_VALUE = 1024, MAX_KEY = 100000;
    public final Kind kind;
    public final String document;
    public final int focused, username, password;
    public final String usernameAutocomplete, passwordAutocomplete;
    /** Field box in CSS pixels of the top-level viewport, and that viewport's CSS width. */
    public final float x, y, width, height, viewportWidth;
    /** Submitted values; only for {@link Kind#SUBMIT}. */
    public final String usernameValue, passwordValue;

    private Report(Kind kind, String document, int focused, int username, int password,
        String usernameAutocomplete, String passwordAutocomplete, float[] box,
        String usernameValue, String passwordValue) {
      this.kind = kind;
      this.document = document;
      this.focused = focused;
      this.username = username;
      this.password = password;
      this.usernameAutocomplete = usernameAutocomplete;
      this.passwordAutocomplete = passwordAutocomplete;
      this.x = box[0];
      this.y = box[1];
      this.width = box[2];
      this.height = box[3];
      this.viewportWidth = box[4];
      this.usernameValue = usernameValue;
      this.passwordValue = passwordValue;
    }

    /** Parsed report, or null when the message is not exactly one of the accepted shapes. */
    public static Report parse(String message) {
      if (message == null || message.isEmpty() || message.length() > MAX_MESSAGE)
        return null;
      String[] part = message.split("\\|", -1);
      try {
        if (part.length < 2 || !part[1].matches("[0-9a-f]{16,32}"))
          return null;
        String doc = part[1];
        float[] none = new float[5];
        switch (part[0]) {
          case "blur":
            return part.length == 2 ? new Report(Kind.BLUR, doc, 0, 0, 0, "", "", none, null, null)
                                    : null;
          case "gone":
            return part.length == 2 ? new Report(Kind.GONE, doc, 0, 0, 0, "", "", none, null, null)
                                    : null;
          case "focus": {
            if (part.length != 8)
              return null;
            int focused = key(part[2], false), username = key(part[3], true),
                password = key(part[4], false);
            if (focused < 0 || username < 0 || password < 0 || username == password
                || (focused != username && focused != password))
              return null;
            String ua = part[5], pa = part[6];
            if (!(ua.isEmpty() || ua.equals("username") || ua.equals("email"))
                || !(pa.isEmpty() || pa.equals("current-password") || pa.equals("new-password")))
              return null;
            if (username == 0 && !ua.isEmpty())
              return null;
            String[] numbers = part[7].split(",", -1);
            if (numbers.length != 5)
              return null;
            float[] box = new float[5];
            for (int i = 0; i < 5; i++) {
              if (!numbers[i].matches("-?[0-9]{1,6}(\\.[0-9]{1,3})?"))
                return null;
              box[i] = Float.parseFloat(numbers[i]);
            }
            if (box[2] < 0 || box[3] < 0 || box[4] < 0)
              return null;
            return new Report(Kind.FOCUS, doc, focused, username, password, ua, pa, box, null, null);
          }
          case "submit": {
            if (part.length != 6)
              return null;
            int username = key(part[2], true), password = key(part[3], false);
            if (username < 0 || password < 0 || username == password)
              return null;
            String u = value(part[4]), p = value(part[5]);
            if (u == null || p == null || p.isEmpty() || (username == 0 && !u.isEmpty()))
              return null;
            return new Report(Kind.SUBMIT, doc, 0, username, password, "", "", none, u, p);
          }
          default:
            return null;
        }
      } catch (RuntimeException malformed) {
        return null;
      }
    }

    /** Positive field key, or 0 when {@code optional} and absent; -1 when invalid. */
    private static int key(String text, boolean optional) {
      if (!text.matches("[0-9]{1,6}"))
        return -1;
      int value = Integer.parseInt(text);
      if (value == 0)
        return optional ? 0 : -1;
      return value > MAX_KEY ? -1 : value;
    }

    private static String value(String encoded) {
      if (encoded.length() > MAX_VALUE * 12 || !encoded.matches("[A-Za-z0-9%._~!*'()-]*"))
        return null;
      String decoded;
      try {
        decoded = URLDecoder.decode(encoded, "UTF-8");
      } catch (UnsupportedEncodingException unavailable) {
        return null;
      }
      if (decoded.length() > MAX_VALUE)
        return null;
      for (int i = 0; i < decoded.length(); i++)
        if (decoded.charAt(i) < 0x20 || decoded.charAt(i) == 0x7f)
          return null;
      return decoded;
    }
  }
}
