import ai.eliza.plugins.browsersurface.BrowserMainFrameGate;
import ai.eliza.plugins.browsersurface.BrowserPageHandoffs;
import ai.eliza.plugins.browsersurface.BrowserPageHandoffs.Dialogs;
import ai.eliza.plugins.browsersurface.BrowserPageHandoffs.Download;
import ai.eliza.plugins.browsersurface.BrowserPageHandoffs.WindowDecision;

/** Plain-JVM checks for BrowserPageHandoffs and BrowserMainFrameGate. */
public final class BrowserPageHandoffsTest {
  private static int assertions;

  private static void check(boolean condition, String message) {
    assertions++;
    if (!condition)
      throw new AssertionError(message);
  }

  private static void equal(Object actual, Object expected, String message) {
    check(expected == null ? actual == null : expected.equals(actual),
        message + ": expected " + expected + " got " + actual);
  }

  public static void main(String[] args) {
    // Dialogs: nobody answers for the person.
    check(BrowserPageHandoffs.dialogMayWait(true, true, 0), "visible dialog waits for the host");
    check(!BrowserPageHandoffs.dialogMayWait(true, false, 0), "hidden surface dialog is dismissed");
    check(!BrowserPageHandoffs.dialogMayWait(false, true, 0), "retired owner dialog is dismissed");
    check(!BrowserPageHandoffs.dialogMayWait(true, true, BrowserPageHandoffs.MAX_PENDING_DIALOGS),
        "a dialog flood is dismissed");
    Dialogs<String> dialogs = new Dialogs<>();
    String first = dialogs.open("first");
    String second = dialogs.open("second");
    check(!first.equals(second) && first.length() >= 32, "dialog ids are unguessable and unique");
    equal(dialogs.take(first), "first", "an answer takes its own dialog");
    equal(dialogs.take(first), null, "a repeated answer does nothing");
    equal(dialogs.take(null), null, "a missing id does nothing");
    equal(dialogs.drain().size(), 1, "closing drains the rest");
    equal(dialogs.size(), 0, "nothing is left after drain");
    equal(BrowserPageHandoffs.text("Pay\u0000now?\nOK"), "Pay now?\nOK", "control characters are spaces");
    equal(BrowserPageHandoffs.text("x".repeat(5000)).length(), BrowserPageHandoffs.MAX_TEXT,
        "dialog text is bounded");
    equal(BrowserPageHandoffs.text(null), "", "missing dialog text is empty");

    // New windows: only a tapped window is reported, never opened by itself.
    equal(BrowserPageHandoffs.window(true, "https://pay.example.com/"), WindowDecision.REQUEST,
        "tapped window is reported");
    equal(BrowserPageHandoffs.window(false, "https://ads.example.net/"), WindowDecision.BLOCK,
        "script popup is refused");
    equal(BrowserPageHandoffs.window(true, "javascript:alert(1)"), WindowDecision.BLOCK,
        "non-web window is refused");
    equal(BrowserPageHandoffs.window(true, null), WindowDecision.BLOCK, "blank window is refused");

    // Identity providers that refuse embedded WebViews.
    equal(BrowserPageHandoffs.identityProvider(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id=x"), "google", "Google OAuth");
    equal(BrowserPageHandoffs.identityProvider("https://accounts.google.com/v3/signin/identifier"),
        "google", "Google sign-in");
    equal(BrowserPageHandoffs.identityProvider("https://www.facebook.com/v19.0/dialog/oauth?x=1"),
        "facebook", "Facebook OAuth");
    equal(BrowserPageHandoffs.identityProvider("https://www.facebook.com/somepage"), null,
        "Facebook pages load normally");
    equal(BrowserPageHandoffs.identityProvider("https://login.gov/"), null,
        "identity providers that allow WebViews load normally");
    equal(BrowserPageHandoffs.identityProvider("http://accounts.google.com/"), null,
        "plain http is not a sign-in hand-off");
    equal(BrowserPageHandoffs.identityProvider("https://accounts.google.com.evil.example/"), null,
        "lookalike hosts are not hand-offs");

    // Downloads are described, never started.
    Download pdf = new Download("https://bills.example.com/s.pdf?token=1", "../Statement Oct.pdf",
        "Application/PDF", 1234);
    check(pdf.pdf, "PDF by type");
    equal(pdf.fileName, "_Statement Oct.pdf", "names are portable");
    equal(pdf.mimeType, "application/pdf", "types are lower case");
    Download blob = new Download("blob:https://bills.example.com/1", "bill.pdf", "bad type", -5);
    equal(blob.url, null, "blob bodies stay in the page");
    check(blob.pdf, "PDF by name");
    equal(blob.mimeType, "application/octet-stream", "invalid types are generic");
    equal(blob.contentLength, -1L, "unknown length");
    check(BrowserPageHandoffs.validTextZoom(100) && BrowserPageHandoffs.validTextZoom(300)
            && !BrowserPageHandoffs.validTextZoom(49) && !BrowserPageHandoffs.validTextZoom(301),
        "text zoom bounds");

    // The main-frame gate: a blocked host never receives the request.
    BrowserMainFrameGate gate = new BrowserMainFrameGate();
    check(!gate.admit("https://bank.example.com/"), "nothing is admitted before the host approves");
    gate.approve("https://bank.example.com/login");
    check(gate.admit("https://bank.example.com/other"), "approved origin");
    gate.commit("https://bank.example.com/login");
    check(gate.admit("https://bank.example.com/pay"), "same-origin POST goes out");
    check(!gate.admit("https://collector.evil.example/steal"), "cross-origin POST is held");
    check(!gate.admit("http://bank.example.com/pay"), "scheme downgrade is held");
    check(!gate.admit("intent://x#Intent;end"), "non-web is held");
    gate.approve("https://login.gov/");
    gate.commit("https://login.gov/");
    check(!gate.admit("https://bank.example.com/"), "leaving an origin needs a new approval");
    gate.approve("javascript:alert(1)");
    check(!gate.admit("javascript:alert(1)"), "non-web approvals are ignored");

    // A task the host extended: its origins reach each other, nothing else does.
    BrowserMainFrameGate task = new BrowserMainFrameGate();
    task.approve("https://www.ssa.gov/");
    task.commit("https://www.ssa.gov/");
    // The initial host-approved navigation has finished before the task moves between origins.
    task.settle("https://www.ssa.gov/");
    check(!task.admit("https://secure.login.gov/"), "the sign-in origin waits until the host extends the task");
    check(!task.setTaskOrigins(java.util.List.of("https://www.ssa.gov", "https://secure.login.gov/path")),
        "a path is not an origin");
    check(!task.setTaskOrigins(java.util.List.of("https://www.ssa.gov", "http://secure.login.gov")),
        "task origins are HTTPS only");
    check(!task.admit("https://secure.login.gov/"), "a refused list changes nothing");
    check(task.setTaskOrigins(java.util.List.of("https://www.ssa.gov", "https://secure.login.gov")),
        "exact HTTPS origins are accepted");
    check(task.admit("https://secure.login.gov/sign-in"), "a POST to the extended origin goes out");
    check(!task.admit("https://collector.evil.example/"), "other origins are still held");
    task.commit("https://secure.login.gov/sign-in");
    check(task.admit("https://www.ssa.gov/myaccount"), "the return to the starting origin goes out");
    task.commit("https://collector.evil.example/");
    check(!task.admit("https://www.ssa.gov/"), "a page outside the task cannot use its origins");
    task.commit("https://www.ssa.gov/");
    check(task.setTaskOrigins(java.util.List.of()), "an empty list ends the extension");
    check(!task.admit("https://secure.login.gov/"), "a retracted origin is held again");

    System.out.println(assertions + " assertions passed");
  }
}
