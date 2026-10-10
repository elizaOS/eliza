import ai.eliza.plugins.passwords.PasswordFormPolicy;
import ai.eliza.plugins.passwords.PasswordFormPolicy.Node;
import ai.eliza.plugins.passwords.PasswordFormPolicy.Target;
import ai.eliza.plugins.passwords.PasswordGenerator;
import ai.eliza.plugins.passwords.PasswordMatching;
import ai.eliza.plugins.passwords.PasswordRequests;
import ai.eliza.plugins.securestore.nativeonly.PasswordFacets;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** JVM tests with synthetic structures and values only; no Android framework or real secrets. */
public final class PasswordPolicyTest {
  private static int checks;
  private static void check(boolean value) { checks++; if (!value) throw new AssertionError("Check " + checks); }
  private interface Failing { void run() throws Exception; }
  private static void rejects(String reason, Failing body) {
    checks++;
    try { body.run(); } catch (PasswordFormPolicy.Rejected expected) {
      if (!expected.getMessage().equals(reason)) throw new AssertionError("Check " + checks + ": " + expected.getMessage());
      return;
    } catch (Exception other) { if (reason == null) return; throw new AssertionError("Check " + checks + ": " + other); }
    throw new AssertionError("Check " + checks + " should have been rejected");
  }

  static final String HOST = "ai.example.host", BROWSER = "org.example.browser", APP = "com.example.bank";
  static final PasswordFormPolicy.BrowserTrust TRUST = BROWSER::equals;
  static final int TEXT = 1, TEXT_PASSWORD = 0x81, TEXT_EMAIL = 0x21;

  static Node field(String id, int inputType, String... hints) { Node node = new Node(); node.id = id; node.text = true; node.inputType = inputType; node.hints = Arrays.asList(hints); return node; }
  static Node web(String domain, String scheme, Node... children) { Node node = new Node(); node.webDomain = domain; node.webScheme = scheme; for (Node child : children) node.add(child); return node; }
  static Node root(Node... children) { Node node = new Node(); for (Node child : children) node.add(child); return node; }
  static Target fill(String pkg, boolean hostBrowser, Node root) throws Exception { return PasswordFormPolicy.evaluate(pkg, HOST, hostBrowser, root, TRUST, false); }

  public static void main(String[] args) throws Exception {
    // Generator: every class present, only declared alphabet, bounds enforced.
    SecureRandom random = new SecureRandom();
    String alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!#$%&*+-=?@^_~";
    Set<Character> seen = new HashSet<>();
    for (int run = 0; run < 400; run++) {
      String value = PasswordGenerator.generate(PasswordGenerator.Options.defaults(), random);
      check(value.length() == 20);
      check(value.chars().anyMatch(Character::isLowerCase) && value.chars().anyMatch(Character::isUpperCase)
        && value.chars().anyMatch(Character::isDigit) && value.chars().anyMatch(c -> "!#$%&*+-=?@^_~".indexOf(c) >= 0));
      for (char c : value.toCharArray()) { check(alphabet.indexOf(c) >= 0); seen.add(c); }
    }
    check(seen.size() == alphabet.length());
    String digits = PasswordGenerator.generate(new PasswordGenerator.Options(8, false, false, true, false), random);
    check(digits.matches("[2-9]{8}"));
    rejects(null, () -> PasswordGenerator.generate(new PasswordGenerator.Options(7, true, true, true, true), random));
    rejects(null, () -> PasswordGenerator.generate(new PasswordGenerator.Options(129, true, true, true, true), random));
    rejects(null, () -> PasswordGenerator.generate(new PasswordGenerator.Options(20, false, false, false, false), random));

    // Native app sign-in binds to the framework-reported package, never the host.
    Target app = fill(APP, true, root(field("user", TEXT_EMAIL), field("pass", TEXT_PASSWORD)));
    check(!app.web() && APP.equals(app.appPackage) && "user".equals(app.usernameId) && "pass".equals(app.passwordId) && app.password == null);
    rejects("Host interface is never filled", () -> fill(HOST, true, root(field("user", TEXT), field("pass", TEXT_PASSWORD))));
    // Password classification needs an explicit signal; an id or label saying "password" is not one.
    Node misleading = field("password", TEXT); misleading.hints = Arrays.asList("Enter password");
    rejects("No password field", () -> fill(APP, false, root(field("user", TEXT), misleading)));
    Node htmlPassword = field("p", TEXT); htmlPassword.htmlType = "password";
    check("p".equals(fill(APP, false, root(field("u", TEXT), htmlPassword)).passwordId));
    check("p".equals(fill(APP, false, root(field("u", TEXT), field("p", TEXT, "current-password"))).passwordId));
    rejects("Ambiguous password fields", () -> fill(APP, false, root(field("u", TEXT), field("p1", TEXT_PASSWORD), field("p2", TEXT_PASSWORD))));
    Node hidden = field("hidden", TEXT_PASSWORD); hidden.visible = false;
    check("p".equals(fill(APP, false, root(field("u", TEXT), hidden, field("p", TEXT_PASSWORD))).passwordId));
    // Username: explicit hint wins over the nearest preceding field; otherwise nearest preceding.
    check("email".equals(fill(APP, false, root(field("email", TEXT, "emailAddress"), field("search", TEXT), field("p", TEXT_PASSWORD))).usernameId));
    check("second".equals(fill(APP, false, root(field("first", TEXT), field("second", TEXT), field("p", TEXT_PASSWORD), field("after", TEXT))).usernameId));
    check(fill(APP, false, root(field("p", TEXT_PASSWORD))).usernameId == null);

    // Web content: trusted browser, one HTTPS domain, exact origin.
    Target site = fill(BROWSER, false, web("Accounts.Example.com", "https", field("u", TEXT), field("p", TEXT_PASSWORD)));
    check(site.web() && site.webOrigin.equals("https://accounts.example.com") && site.appPackage == null);
    rejects("Untrusted browser", () -> fill(APP, false, web("example.com", "https", field("u", TEXT), field("p", TEXT_PASSWORD))));
    rejects("Insecure origin", () -> fill(BROWSER, false, web("example.com", "http", field("u", TEXT), field("p", TEXT_PASSWORD))));
    rejects("Insecure origin", () -> fill(BROWSER, false, web("example.com", null, field("u", TEXT), field("p", TEXT_PASSWORD))));
    // A cross-origin iframe reports a second domain anywhere in the structure: refuse everything.
    rejects("Cross-origin frame", () -> fill(BROWSER, false, web("example.com", "https", field("u", TEXT),
      web("evil.example", "https", field("p", TEXT_PASSWORD)))));
    rejects("Cross-origin frame", () -> fill(BROWSER, false, web("example.com", "https", field("u", TEXT), field("p", TEXT_PASSWORD),
      web("ads.example", "https", field("x", TEXT)))));
    // Browser chrome (an address bar) is native; it is never chosen as the web username.
    check(fill(BROWSER, false, root(field("address-bar", TEXT), web("example.com", "https", field("p", TEXT_PASSWORD)))).usernameId == null);
    rejects("Mixed native and web fields", () -> fill(BROWSER, false, root(field("native-pass", TEXT_PASSWORD), web("example.com", "https", field("u", TEXT)))));
    // Host-owned browser: its WebView must report the committed top-level origin, and it must match.
    Node hostView = web("example.com", "https", field("u", TEXT), field("p", TEXT_PASSWORD)); hostView.topOrigin = "https://example.com";
    check(fill(HOST, true, root(hostView)).webOrigin.equals("https://example.com"));
    rejects("Untrusted browser", () -> fill(HOST, false, root(hostView)));
    Node framed = web("login.example", "https", field("u", TEXT), field("p", TEXT_PASSWORD)); framed.topOrigin = "https://news.example";
    rejects("Cross-origin frame", () -> fill(HOST, true, root(framed)));
    // Field domains carry no port; the host's top-level origin supplies the exact one.
    Node ported = web("example.com", "https", field("u", TEXT), field("p", TEXT_PASSWORD)); ported.topOrigin = "https://example.com:8443";
    Target portedTarget = fill(HOST, true, root(ported));
    check(portedTarget.webOrigin.equals("https://example.com:8443"));
    check(!PasswordMatching.matches(Arrays.asList("https://example.com"), portedTarget, null));
    check(PasswordMatching.matches(Arrays.asList("https://example.com:8443"), portedTarget, null));
    Node defaultPort = web("example.com", "https", field("u", TEXT), field("p", TEXT_PASSWORD)); defaultPort.topOrigin = "https://example.com:443";
    check(fill(HOST, true, root(defaultPort)).webOrigin.equals("https://example.com"));
    Node subdomainTop = web("accounts.example.com", "https", field("u", TEXT), field("p", TEXT_PASSWORD)); subdomainTop.topOrigin = "https://example.com";
    rejects("Cross-origin frame", () -> fill(HOST, true, root(subdomainTop)));
    Node httpTop = web("example.com", "https", field("u", TEXT), field("p", TEXT_PASSWORD)); httpTop.topOrigin = "http://example.com";
    rejects("Top-level origin unavailable", () -> fill(HOST, true, root(httpTop)));
    Node missingTop = web("example.com", "https", field("u", TEXT), field("p", TEXT_PASSWORD));
    rejects("Top-level origin unavailable", () -> fill(HOST, true, root(missingTop)));
    Node strayTop = root(field("u", TEXT), field("p", TEXT_PASSWORD)); strayTop.topOrigin = "https://example.com";
    rejects("Top-level origin without web fields", () -> fill(APP, false, strayTop));
    Node deep = root(); Node cursor = deep;
    for (int i = 0; i < 60; i++) { Node next = root(); cursor.add(next); cursor = next; }
    cursor.add(field("p", TEXT_PASSWORD));
    rejects("Form exceeds bounds", () -> fill(APP, false, deep));

    // Save capture: values are read only for save requests and must agree across confirm fields.
    Node user = field("u", TEXT_EMAIL); user.value = "synthetic.user@example.test";
    Node pass = field("p", TEXT_PASSWORD); pass.value = "synthetic-value-1";
    Node confirm = field("c", TEXT_PASSWORD); confirm.value = "synthetic-value-1";
    Target captured = PasswordFormPolicy.evaluate(BROWSER, HOST, false, web("example.com", "https", user, pass, confirm), TRUST, true);
    check("synthetic.user@example.test".equals(captured.username) && "synthetic-value-1".equals(captured.password));
    Target stripped = captured.withoutValues();
    check(stripped.password == null && stripped.username == null && stripped.webOrigin.equals(captured.webOrigin));
    Node mismatch = field("c", TEXT_PASSWORD); mismatch.value = "synthetic-value-2";
    rejects("Different passwords entered", () -> PasswordFormPolicy.evaluate(BROWSER, HOST, false, web("example.com", "https", user, pass, mismatch), TRUST, true));
    Node empty = field("p", TEXT_PASSWORD); empty.value = "";
    rejects("No password entered", () -> PasswordFormPolicy.evaluate(APP, HOST, false, root(user, empty), TRUST, true));

    // Matching: exact origin; app bindings require the stored signer.
    String cert = "ab".repeat(32), otherCert = "cd".repeat(32);
    List<String> bindings = Arrays.asList("https://accounts.example.com", PasswordFacets.android(APP, cert));
    PasswordMatching.SignerCheck signers = (pkg, digest) -> APP.equals(pkg) && cert.equals(digest);
    check(PasswordMatching.matches(bindings, site, signers));
    check(!PasswordMatching.matches(Arrays.asList("https://example.com"), site, signers));
    check(PasswordMatching.matches(bindings, app, signers));
    check(!PasswordMatching.matches(bindings, app, (pkg, digest) -> false));
    check(!PasswordMatching.matches(Arrays.asList(PasswordFacets.android(APP, otherCert)), app, signers));
    check(!PasswordMatching.matches(Arrays.asList(PasswordFacets.android("com.example.other", cert)), app, signers));
    check(!PasswordMatching.matches(Arrays.asList("https://accounts.example.com"), app, signers));

    // Request capabilities: one-shot, replaced by newer offers, expiring, values never in fill offers.
    long[] now = {1000};
    PasswordRequests requests = new PasswordRequests(() -> now[0], random);
    String first = requests.offerFill(captured);
    check(first.matches("[a-f0-9]{48}"));
    String second = requests.offerFill(site);
    check(requests.takeFill(first) == null);
    Target offered = requests.takeFill(second);
    check(offered != null && offered.password == null && requests.takeFill(second) == null);
    String expiring = requests.offerFill(site);
    now[0] += PasswordRequests.FILL_TTL_MILLIS;
    check(requests.takeFill(expiring) == null);
    String saveToken = requests.offerSave(captured, captured.webOrigin);
    check(requests.takeSave("not-a-token") == null);
    PasswordRequests.SaveCapture saved = requests.takeSave(saveToken);
    check(saved != null && "synthetic-value-1".equals(saved.target.password) && captured.webOrigin.equals(saved.facet) && requests.takeSave(saveToken) == null);
    String cancelled = requests.offerFill(site); requests.cancelFill(cancelled);
    check(requests.takeFill(cancelled) == null);
    String opened = requests.offerFill(site);
    check(requests.takeFill(opened) != null && requests.currentFill(opened));
    requests.cancelFill(opened);
    check(!requests.currentFill(opened) && !requests.claimFill(opened));
    String older = requests.offerFill(site);
    check(requests.takeFill(older) != null);
    String newer = requests.offerFill(site);
    check(!requests.currentFill(older) && !requests.claimFill(older));
    requests.cancelFill(older);
    check(requests.takeFill(newer) != null && requests.claimFill(newer));
    check(!requests.claimFill(newer));
    String aging = requests.offerFill(site);
    now[0] += PasswordRequests.FILL_TTL_MILLIS - 1;
    check(requests.takeFill(aging) != null);
    now[0]++;
    check(!requests.currentFill(aging) && !requests.claimFill(aging));
    System.out.println(checks + " assertions passed");
  }
}
