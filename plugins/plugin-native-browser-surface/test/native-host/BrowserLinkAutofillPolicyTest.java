import ai.eliza.plugins.browsersurface.BrowserAutofillEligibility;
import ai.eliza.plugins.browsersurface.BrowserAutofillEligibility.Reason;
import ai.eliza.plugins.browsersurface.BrowserAutofillEligibility.SessionEnd;
import ai.eliza.plugins.browsersurface.BrowserAutofillEligibility.TabState;
import ai.eliza.plugins.browsersurface.BrowserExternalLinkPolicy;
import ai.eliza.plugins.browsersurface.BrowserExternalLinkPolicy.Handoff;
import java.util.Arrays;
import java.util.Set;

/** Plain-JVM checks for BrowserExternalLinkPolicy and BrowserAutofillEligibility. */
public final class BrowserLinkAutofillPolicyTest {
  private static int assertions;
  private static final String OWN = "com.example.host";
  private static final Set<String> HOST_SCHEMES = Set.of("examplehost");

  private static void check(boolean condition, String message) {
    assertions++;
    if (!condition)
      throw new AssertionError(message);
  }

  private static void equal(Object actual, Object expected, String message) {
    check(expected == null ? actual == null : expected.equals(actual),
        message + ": expected " + expected + " got " + actual);
  }

  private static Handoff tap(String raw) {
    return BrowserExternalLinkPolicy.decide(raw, true, null, null, null, OWN, HOST_SCHEMES);
  }

  private static Handoff intent(String action, String dataScheme, String pkg) {
    return BrowserExternalLinkPolicy.decide(
        "intent://x#Intent;end", true, action, dataScheme, pkg, OWN, HOST_SCHEMES);
  }

  private static TabState eligibleTab() {
    TabState tab = new TabState();
    tab.selected = true;
    tab.shown = true;
    tab.committed = true;
    tab.documentUrl = "https://login.example.test/";
    tab.engineUrl = "https://login.example.test/";
    return tab;
  }

  public static void main(String[] args) {
    // Which links leave the browser.
    for (String raw : Arrays.asList("mailto:a@example.test", "TEL:+15550100",
             "market://details?id=x", "intent://x#Intent;end"))
      check(BrowserExternalLinkPolicy.external(raw), "external " + raw);
    for (String raw : Arrays.asList("https://example.test/", "javascript:x", "file:///x",
             "content://x", "sms:1", "", ":x", "1tel:2"))
      check(!BrowserExternalLinkPolicy.external(raw), "not external " + raw);
    check(!BrowserExternalLinkPolicy.external(null), "null not external");

    // Handoff kinds.
    equal(tap("mailto:a@example.test"), Handoff.SEND_TO, "mailto sends to");
    equal(tap("tel:+15550100"), Handoff.DIAL, "tel only dials");
    equal(tap("market://details?id=x"), Handoff.VIEW, "market views");
    equal(tap("https://example.test/"), Handoff.REFUSE, "web link is not a handoff");
    equal(tap("javascript:alert(1)"), Handoff.REFUSE, "javascript refused");
    equal(BrowserExternalLinkPolicy.decide(
              "tel:+15550100", false, null, null, null, OWN, HOST_SCHEMES),
        Handoff.REFUSE, "script navigation refused");
    equal(tap("mailto:a@example.test\n"), Handoff.REFUSE, "control character refused");
    char[] longLink = new char[BrowserExternalLinkPolicy.MAX_LINK];
    Arrays.fill(longLink, 'a');
    equal(tap("mailto:" + new String(longLink)), Handoff.REFUSE, "over-long refused");
    equal(tap(null), Handoff.REFUSE, "null refused");

    // intent: links.
    equal(intent(null, "https", null), Handoff.VIEW, "implicit view of https");
    equal(intent(BrowserExternalLinkPolicy.ACTION_VIEW, "geo", "com.example.maps"), Handoff.VIEW,
        "view in another package");
    equal(intent(null, null, null), Handoff.VIEW, "no data is still only a view");
    equal(intent("android.intent.action.CALL", "tel", null), Handoff.REFUSE, "CALL refused");
    equal(intent("android.intent.action.SEND", null, null), Handoff.REFUSE, "SEND refused");
    for (String data : Arrays.asList(
             "file", "CONTENT", "javascript", "data", "blob", "about", "intent", "android-app", ""))
      equal(intent(null, data, null), Handoff.REFUSE, "forbidden data " + data);
    equal(intent(null, "ExampleHost", null), Handoff.REFUSE, "host scheme refused");
    equal(intent(null, "https", OWN), Handoff.REFUSE, "own package refused");
    equal(BrowserExternalLinkPolicy.decide(
              "intent://x#Intent;end", true, null, "https", null, OWN, null),
        Handoff.VIEW, "no host schemes");

    // Fallback addresses.
    equal(BrowserExternalLinkPolicy.fallback("https://example.test/app"),
        "https://example.test/app", "https fallback");
    equal(BrowserExternalLinkPolicy.fallback("HTTPS://example.test/"), "HTTPS://example.test/",
        "scheme case");
    for (String bad :
        Arrays.asList("http://example.test/", "javascript:x", "https://u:p@example.test/",
            "https:///x", "https://example.test/a b", "https://example.test/\t", ""))
      equal(BrowserExternalLinkPolicy.fallback(bad), null, "fallback refused " + bad);
    equal(BrowserExternalLinkPolicy.fallback(null), null, "null fallback");

    // Autofill eligibility.
    check(BrowserAutofillEligibility.eligible(eligibleTab()), "selected committed https tab");
    TabState tab;
    tab = eligibleTab();
    tab.paused = true;
    check(!BrowserAutofillEligibility.eligible(tab), "paused");
    tab = eligibleTab();
    tab.closed = true;
    check(!BrowserAutofillEligibility.eligible(tab), "closed");
    tab = eligibleTab();
    tab.selected = false;
    check(!BrowserAutofillEligibility.eligible(tab), "background tab");
    tab = eligibleTab();
    tab.shown = false;
    check(!BrowserAutofillEligibility.eligible(tab), "hidden");
    tab = eligibleTab();
    tab.overlay = true;
    check(!BrowserAutofillEligibility.eligible(tab), "overlay");
    tab = eligibleTab();
    tab.committed = false;
    check(!BrowserAutofillEligibility.eligible(tab), "uncommitted");
    tab = eligibleTab();
    tab.loading = true;
    check(!BrowserAutofillEligibility.eligible(tab), "loading");
    tab = eligibleTab();
    tab.loadError = "net";
    check(!BrowserAutofillEligibility.eligible(tab), "load error");
    tab = eligibleTab();
    tab.loadError = null;
    check(BrowserAutofillEligibility.eligible(tab), "null error is no error");
    tab = eligibleTab();
    tab.documentUrl = tab.engineUrl = "http://login.example.test/";
    check(!BrowserAutofillEligibility.eligible(tab), "cleartext");
    tab = eligibleTab();
    tab.engineUrl = "https://other.example.test/";
    check(!BrowserAutofillEligibility.eligible(tab), "engine moved on");
    tab = eligibleTab();
    tab.documentUrl = null;
    check(!BrowserAutofillEligibility.eligible(tab), "no document");
    check(!BrowserAutofillEligibility.eligible(null), "no tab");
    for (String invalid : Arrays.asList("https:///missing-host", "https://user:pw@example.test/",
             "https://example.test:65536/")) {
      tab = eligibleTab();
      tab.documentUrl = tab.engineUrl = invalid;
      check(!BrowserAutofillEligibility.eligible(tab), "invalid committed origin refused");
    }

    // Session end.
    equal(BrowserAutofillEligibility.end(Reason.PAGE_MAIN_FRAME_NAVIGATION, true),
        SessionEnd.COMMIT, "page navigation commits");
    equal(BrowserAutofillEligibility.end(Reason.PAGE_MAIN_FRAME_NAVIGATION, false),
        SessionEnd.CANCEL, "ineligible navigation cancels");
    for (Reason reason : Arrays.asList(Reason.USER_ENTERED_ADDRESS, Reason.TAB_SWITCH,
             Reason.OVERLAY, Reason.LOAD_ERROR, Reason.RENDERER_GONE, Reason.CLOSE))
      equal(
          BrowserAutofillEligibility.end(reason, true), SessionEnd.CANCEL, "cancels on " + reason);
    equal(BrowserAutofillEligibility.end(Reason.PAUSE, true), null, "pause keeps the session");

    System.out.println(assertions + " assertions passed");
  }
}
