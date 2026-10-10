package ai.eliza.plugins.browsersurface;

import java.util.Objects;

/**
 * When a browser-surface tab may take part in the platform autofill framework, and how its
 * framework session ends.
 *
 * <p>A tab is eligible only while it is the selected, presented tab of a running (not paused)
 * surface, its HTTPS document is committed and finished without a load error, and the address the
 * engine reports equals the recorded document address. The host marks an ineligible tab's view as
 * excluded from autofill, so the framework neither requests its structure nor delivers fill values.
 * A page-initiated main-frame navigation of an eligible tab (a sign-in form usually navigates)
 * commits the session so the user's provider can offer to save; every other end cancels it. The
 * provider still asks the user before saving. The host never reads field values, supplies a web
 * domain of its own or exposes credentials to its renderer or agent. Pure JVM; no Android types.
 */
public final class BrowserAutofillEligibility {
  private BrowserAutofillEligibility() {}

  /** The facts the host knows about one tab. */
  public static final class TabState {
    public boolean paused;
    public boolean closed;
    public boolean selected;
    public boolean shown;
    public boolean committed;
    public boolean loading;
    public boolean overlay;
    public String loadError = "";
    /** The address the host recorded for the committed document. */
    public String documentUrl = "";
    /** The address the engine reports now. */
    public String engineUrl = "";
  }

  public enum SessionEnd { COMMIT, CANCEL }

  /** Why the tab is leaving its current document or eligibility. */
  public enum Reason {
    PAGE_MAIN_FRAME_NAVIGATION,
    USER_ENTERED_ADDRESS,
    TAB_SWITCH,
    OVERLAY,
    LOAD_ERROR,
    RENDERER_GONE,
    CLOSE,
    PAUSE
  }

  public static boolean eligible(TabState tab) {
    if (tab == null || tab.paused || tab.closed || tab.overlay)
      return false;
    if (!tab.selected || !tab.shown || !tab.committed || tab.loading)
      return false;
    if (tab.loadError != null && !tab.loadError.isEmpty())
      return false;
    String url = tab.documentUrl;
    String origin = BrowserWebOrigin.of(url);
    if (origin == null || !origin.startsWith("https://"))
      return false;
    return Objects.equals(url, tab.engineUrl);
  }

  /**
   * How the framework session of a tab that was eligible ends. Only a page-initiated main-frame
   * navigation commits. Pause returns null: the session is kept (a provider may open its own
   * unlock screen), and the tab is ineligible until it is presented again.
   */
  public static SessionEnd end(Reason reason, boolean wasEligible) {
    if (reason == Reason.PAUSE)
      return null;
    return wasEligible && reason == Reason.PAGE_MAIN_FRAME_NAVIGATION ? SessionEnd.COMMIT
                                                                      : SessionEnd.CANCEL;
  }
}
