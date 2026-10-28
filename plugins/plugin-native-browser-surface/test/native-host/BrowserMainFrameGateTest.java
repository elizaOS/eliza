import ai.eliza.plugins.browsersurface.BrowserMainFrameGate;

/** Plain-JVM checks for BrowserMainFrameGate: approved navigations land, nothing else leaves. */
public final class BrowserMainFrameGateTest {
  private static int assertions;

  private static void check(boolean condition, String message) {
    assertions++;
    if (!condition)
      throw new AssertionError(message);
  }

  /** A surface whose approved first address has loaded. */
  private static BrowserMainFrameGate on(String url) {
    BrowserMainFrameGate gate = new BrowserMainFrameGate();
    gate.approve(url);
    gate.commit(url);
    gate.settle(url);
    return gate;
  }

  public static void main(String[] args) {
    // 1. Same-site scheme upgrade (HSTS, HTTPS-first) of an approved address.
    BrowserMainFrameGate gate = on("https://shop.example/");
    gate.approve("http://example.org/");
    check(gate.admit("http://example.org/"), "approved http address");
    check(gate.admit("https://example.org/"), "its https upgrade");
    check(gate.redirect("https://example.org/"), "the upgrade hop continues the navigation");
    check(!gate.admit("https://example.org:8443/"), "an upgrade never changes the port");
    check(!gate.admit("https://www.example.org/"), "an upgrade never changes the host");
    check(!gate.admit("https://evil.example/"), "an arbitrary host is refused");
    gate.commit("https://example.org/");
    gate.settle("https://example.org/");
    check(gate.admit("https://example.org/next"), "the upgraded page is the committed origin");
    check(!gate.admit("http://example.org/"), "a downgrade of the committed page is refused");
    gate = on("http://intranet.example:8080/");
    check(!gate.admit("https://intranet.example:8080/"), "no upgrade from a non-default port");
    check(!gate.admit("https://intranet.example/"), "no upgrade to another port");
    gate = on("http://plain.example/");
    check(gate.admit("https://plain.example/form"), "upgrade of the committed origin");
    gate = on("https://secure.example/");
    gate.approve("https://next.example/");
    check(!gate.admit("http://next.example/"), "an approval never implies a downgrade");

    // 2. Redirects of an approved navigation in flight.
    gate = on("https://shop.example/");
    gate.approve("https://bank.example/");
    check(gate.redirect("https://bank.example/login"), "same-origin redirect continues it");
    check(gate.admit("https://bank.example/login"), "and its hop goes out");
    check(!gate.redirect("https://www.bank.example/"), "another host is left to the policy");
    check(!gate.admit("https://www.bank.example/"), "and its hop is never sent");
    check(!gate.redirect("http://bank.example/"), "a downgrade redirect is not continued");
    check(!gate.redirect("https://shop.example/"), "the committed page is not the navigation");
    check(!gate.redirect("javascript:alert(1)"), "non-web redirect");
    gate.settle(null);
    check(!gate.redirect("https://bank.example/again"), "a held redirect ends the approval");
    check(!gate.admit("https://bank.example/again"), "nothing lingers after it is held");
    check(gate.admit("https://shop.example/"), "the committed page still loads");

    // 3. Further main-frame requests of the same navigation, until it settles.
    gate = on("https://shop.example/");
    gate.approve("https://bank.example/");
    gate.commit("https://bank.example/");
    gate.commit("https://shop.example/old");
    check(gate.admit("https://bank.example/"), "a commit does not consume the approval");
    gate.settle("https://shop.example/old");
    check(gate.admit("https://bank.example/"), "the page being left finishing changes nothing");
    gate.settle("https://bank.example/");
    check(!gate.admit("https://bank.example/"), "the approval ends when its navigation finishes");
    gate = on("https://shop.example/");
    gate.approve("https://bank.example/");
    gate.approve("https://news.example/");
    check(!gate.admit("https://bank.example/"), "the next host approval supersedes the last");
    check(gate.admit("https://news.example/"), "the current approval stands");

    // 4. Reload and history.
    gate = on("https://shop.example/cart");
    check(gate.admit("https://shop.example/cart"), "reload of the committed page");
    check(gate.admit("https://shop.example/"), "history move within the committed origin");
    gate.approve("https://bank.example/");
    gate.commit("https://bank.example/");
    gate.settle("https://bank.example/");
    check(!gate.admit("https://shop.example/cart"), "the page's own back to an origin it left");
    gate.approve("https://shop.example/cart");
    check(gate.admit("https://shop.example/cart"), "goBack approves its entry");
    gate.commit("https://shop.example/cart");
    gate.settle("https://shop.example/cart");
    gate.approve("https://bank.example/");
    check(gate.admit("https://bank.example/"), "goForward approves its entry");

    // A host the app did not approve never receives a main-frame request.
    gate = on("https://bank.example/login");
    check(gate.admit("https://bank.example/pay"), "same-origin POST");
    check(!gate.admit("https://collector.evil.example/steal"), "unapproved cross-origin POST");
    check(!gate.admit("http://bank.example/pay"), "downgraded POST");
    check(!gate.admit("intent://x#Intent;end"), "non-web");
    check(!gate.admit("https://user@bank.example/"), "credentials");
    gate.approve("javascript:alert(1)");
    check(!gate.admit("javascript:alert(1)"), "non-web approvals are ignored");
    check(!new BrowserMainFrameGate().admit("https://bank.example/"), "nothing before an approval");

    System.out.println(assertions + " assertions passed");
  }
}
