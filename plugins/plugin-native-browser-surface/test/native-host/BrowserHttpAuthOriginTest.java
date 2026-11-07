import ai.eliza.plugins.browsersurface.BrowserAutofillEligibility;
import ai.eliza.plugins.browsersurface.BrowserHttpAuthOrigin;
import ai.eliza.plugins.passwords.PasswordFormPolicy;
import ai.eliza.plugins.passwords.PasswordFormPolicy.Node;

/**
 * Plain-JVM check that the HTTP authentication prompt's origin rule (BrowserHttpAuthOrigin) and the
 * field shape BrowserHttpAuthAutofill reports are accepted by plugin-native-passwords'
 * PasswordFormPolicy for exactly the verified origin, and refused for wrong origins, frames,
 * missing field origins and an untrusted host. The structures are hand-built mirrors of what the
 * Android views report; Android, AssistStructure, a provider, a vault and a device are not run here.
 */
public final class BrowserHttpAuthOriginTest {
 static final String HOST = "com.example.browser";
 static final int CLASS_TEXT = 1, TEXT_PASSWORD = 0x80, TEXT_VISIBLE_PASSWORD = 0x90, FLAG_NO_SUGGESTIONS = 0x80000;
 static int checks = 0;

 static void eq(Object expected, Object actual, String what) {
  if (expected == null ? actual != null : !expected.equals(actual)) throw new AssertionError(what + ": expected " + expected + " got " + actual);
  checks++;
 }

 /** Mirrors BrowserHttpAuthAutofill.field(...) plus OriginField.onProvideAutofillStructure. */
 static Node field(String origin, boolean password, int id, String value) {
  Node node = new Node();
  node.id = "f" + id; node.text = true; node.visible = true; node.focused = password;
  node.inputType = CLASS_TEXT | (password ? TEXT_PASSWORD : FLAG_NO_SUGGESTIONS);
  node.hints = java.util.List.of(password ? "password" : "username");
  if (origin != null) {
   // ViewStructure.setWebDomain(origin) stores scheme and host; the port travels in the extras.
   java.net.URI uri = java.net.URI.create(origin);
   node.webDomain = uri.getHost(); node.webScheme = uri.getScheme();
   node.topOrigin = origin; node.fieldOrigin = origin;
  }
  node.value = value;
  return node;
 }

 static Node prompt(String origin, String user, String pass) {
  Node root = new Node(); // the dialog window: title and message are not text fields
  Node title = new Node(); title.id = "title"; root.add(title);
  root.add(field(origin, false, 1, user)).add(field(origin, true, 2, pass));
  return root;
 }

 /** A request whose structure also holds an enabled tab WebView with its own web login form.
  * {@code withPassword=false} leaves only a username field on the page. */
 static Node withTab(String promptOrigin, String pageOrigin, boolean withPassword) {
  java.net.URI page = java.net.URI.create(pageOrigin);
  Node web = new Node(); web.id = "web"; web.webDomain = page.getHost(); web.webScheme = page.getScheme(); web.topOrigin = pageOrigin;
  Node u = new Node(); u.id = "wu"; u.text = true; u.htmlType = "text"; u.htmlAutocomplete = "username"; u.fieldOrigin = pageOrigin;
  web.add(u);
  if (withPassword) { Node p = new Node(); p.id = "wp"; p.text = true; p.htmlType = "password"; p.fieldOrigin = pageOrigin; web.add(p); }
  Node activity = new Node(); activity.add(web).add(prompt(promptOrigin, null, null));
  return activity;
 }

 static String rejected(Node root, String pkg, boolean hostIsBrowser, boolean forSave) {
  try { PasswordFormPolicy.evaluate(pkg, HOST, hostIsBrowser, root, p -> false, forSave); return null; }
  catch (PasswordFormPolicy.Rejected r) { return r.getMessage(); }
 }

 static BrowserHttpAuthOrigin.EngineChallenge engine(String url, String realm, boolean topLevel, boolean tls, long navigation) {
  return new BrowserHttpAuthOrigin.EngineChallenge(url, realm, topLevel, tls, navigation);
 }
 static BrowserHttpAuthOrigin.TabSnapshot tab(String host, String realm, String pendingMain, long navigation) {
  BrowserHttpAuthOrigin.TabSnapshot t = new BrowserHttpAuthOrigin.TabSnapshot();
  t.reportedHost = host; t.reportedRealm = realm; t.pendingMain = pendingMain; t.navigation = navigation; t.selected = true; t.shown = true;
  return t;
 }
 static String origin(BrowserHttpAuthOrigin.EngineChallenge e, BrowserHttpAuthOrigin.TabSnapshot t) {
  BrowserHttpAuthOrigin.Decision d = BrowserHttpAuthOrigin.bind(e, t);
  if (d.fillable() == (d.refusal != null)) throw new AssertionError("decision is exactly one of origin or refusal");
  return d.origin;
 }
 static String refusal(BrowserHttpAuthOrigin.EngineChallenge e, BrowserHttpAuthOrigin.TabSnapshot t) {
  BrowserHttpAuthOrigin.Decision d = BrowserHttpAuthOrigin.bind(e, t);
  if (d.origin != null) throw new AssertionError("expected refusal, bound " + d.origin);
  return d.refusal;
 }

 public static void main(String[] args) throws Exception {
  // --- Origin rule for the challenge: BrowserHttpAuthOrigin.bind(engineReport, tabSnapshot) ---
  String E = "https://example.com/admin";
  // Standard WebView: no engine report, so even a perfectly consistent tab is refused, with a stated reason.
  eq(BrowserHttpAuthOrigin.NO_ENGINE_ORIGIN, refusal(BrowserHttpAuthOrigin.STANDARD_WEBVIEW.challenge("example.com", "Admin"), tab("example.com", "Admin", E, 7)), "standard WebView reports nothing");
  // An engine-authenticated, top-level, validated HTTPS challenge on the selected visible tab.
  eq("https://example.com", origin(engine(E, "Admin", true, true, 7), tab("example.com", "Admin", E, 7)), "engine-bound top-level challenge");
  eq("https://example.com:8443", origin(engine("https://example.com:8443/a", "Admin", true, true, 7), tab("example.com", "Admin", "https://example.com:8443/a", 7)), "port comes from the engine's request, not WebView's bare host");
  eq("https://example.com:8443", origin(engine("https://example.com:8443/a", "Admin", true, true, 7), tab("example.com:8443", "Admin", "https://example.com:8443/a", 7)), "explicit WebView port agrees");
  eq("https://example.com", origin(engine("https://Example.com:443/a", "Admin", true, true, 7), tab("example.com:443", "Admin", "https://example.com/a", 7)), "default port normalised");
  // Wrong origin.
  eq(BrowserHttpAuthOrigin.MISMATCH, refusal(engine("https://example.com/a", "Admin", true, true, 7), tab("example.com:8443", "Admin", "https://example.com/a", 7)), "WebView port contradicts the engine");
  eq(BrowserHttpAuthOrigin.MISMATCH, refusal(engine("https://example.com/a", "Admin", true, true, 7), tab("accounts.example.com", "Admin", "https://example.com/a", 7)), "subdomain is a different binding");
  eq(BrowserHttpAuthOrigin.MISMATCH, refusal(engine("https://evil.example/a", "Admin", true, true, 7), tab("example.com", "Admin", "https://evil.example/a", 7)), "engine challenge for another host");
  eq(BrowserHttpAuthOrigin.MISMATCH, refusal(engine(E, "Other", true, true, 7), tab("example.com", "Admin", E, 7)), "realm differs");
  eq(BrowserHttpAuthOrigin.MISMATCH, refusal(engine(E, null, true, true, 7), tab("example.com", null, E, 7)), "no realm");
  eq(BrowserHttpAuthOrigin.MISMATCH, refusal(engine("https://user:pw@example.com/a", "Admin", true, true, 7), tab("example.com", "Admin", "https://example.com/a", 7)), "user info");
  eq(BrowserHttpAuthOrigin.MISMATCH, refusal(engine(E, "Admin", true, true, 7), tab("", "Admin", E, 7)), "missing host");
  eq(BrowserHttpAuthOrigin.MISMATCH, refusal(engine("ftp://example.com/", "Admin", true, true, 7), tab("example.com", "Admin", E, 7)), "non-HTTP request");
  // Insecure transport.
  eq(BrowserHttpAuthOrigin.INSECURE, refusal(engine("http://example.com/a", "Admin", true, true, 7), tab("example.com", "Admin", "http://example.com/a", 7)), "cleartext request");
  eq(BrowserHttpAuthOrigin.INSECURE, refusal(engine(E, "Admin", true, false, 7), tab("example.com", "Admin", E, 7)), "TLS not validated by the engine");
  // Redirects: the engine reports the final request; a later main-frame target refuses.
  eq("https://example.com", origin(engine("https://example.com/after-redirect", "Admin", true, true, 7), tab("example.com", "Admin", "https://example.com/after-redirect", 7)), "same-origin redirect is bound to its final request");
  eq(BrowserHttpAuthOrigin.REDIRECTED, refusal(engine(E, "Admin", true, true, 7), tab("example.com", "Admin", "https://example.com:8443/b", 7)), "main frame moved to another port");
  eq(BrowserHttpAuthOrigin.REDIRECTED, refusal(engine(E, "Admin", true, true, 7), tab("example.com", "Admin", "https://other.example/", 7)), "main frame moved to another site");
  eq(BrowserHttpAuthOrigin.INSECURE, refusal(engine("http://example.com/b", "Admin", true, true, 7), tab("example.com", "Admin", "http://example.com/b", 7)), "redirect to cleartext");
  eq(BrowserHttpAuthOrigin.REDIRECTED, refusal(engine(E, "Admin", true, true, 7), tab("example.com", "Admin", null, 7)), "no observed main-frame request");
  // Frames and resources.
  eq(BrowserHttpAuthOrigin.FRAME, refusal(engine(E, "Admin", false, true, 7), tab("example.com", "Admin", E, 7)), "same-origin frame or resource");
  eq(BrowserHttpAuthOrigin.FRAME, refusal(engine("https://example.com:8443/frame", "Admin", false, true, 7), tab("example.com", "Admin", E, 7)), "same-host frame on another port");
  // Stale or hidden tabs.
  eq(BrowserHttpAuthOrigin.STALE, refusal(engine(E, "Admin", true, true, 6), tab("example.com", "Admin", E, 7)), "challenge from an earlier navigation");
  BrowserHttpAuthOrigin.TabSnapshot hidden = tab("example.com", "Admin", E, 7); hidden.shown = false;
  eq(BrowserHttpAuthOrigin.HIDDEN, refusal(engine(E, "Admin", true, true, 7), hidden), "tab not shown");
  BrowserHttpAuthOrigin.TabSnapshot background = tab("example.com", "Admin", E, 7); background.selected = false;
  eq(BrowserHttpAuthOrigin.HIDDEN, refusal(engine(E, "Admin", true, true, 7), background), "tab not selected");
  BrowserHttpAuthOrigin.TabSnapshot paused = tab("example.com", "Admin", E, 7); paused.paused = true;
  eq(BrowserHttpAuthOrigin.HIDDEN, refusal(engine(E, "Admin", true, true, 7), paused), "Activity paused (screen locked or backgrounded)");
  BrowserHttpAuthOrigin.TabSnapshot closed = tab("example.com", "Admin", E, 7); closed.closed = true;
  eq(BrowserHttpAuthOrigin.HIDDEN, refusal(engine(E, "Admin", true, true, 7), closed), "closed tab");
  BrowserHttpAuthOrigin.TabSnapshot failed = tab("example.com", "Admin", E, 7); failed.error = "Page could not load.";
  eq(BrowserHttpAuthOrigin.HIDDEN, refusal(engine(E, "Admin", true, true, 7), failed), "tab showing an error");
  BrowserHttpAuthOrigin.TabSnapshot overlaid = tab("example.com", "Admin", E, 7); overlaid.otherPrompt = true;
  eq(BrowserHttpAuthOrigin.HIDDEN, refusal(engine(E, "Admin", true, true, 7), overlaid), "another site prompt is open");
  eq(BrowserHttpAuthOrigin.HIDDEN, refusal(engine(E, "Admin", true, true, 7), null), "no tab");

  // --- Binding lifetime: lock/unlock, cancel, navigation, tab change ---
  BrowserHttpAuthOrigin.Binding binding = new BrowserHttpAuthOrigin.Binding("https://example.com", 7);
  BrowserHttpAuthOrigin.TabSnapshot now = tab("example.com", "Admin", E, 7);
  eq(true, binding.admits(now), "bound prompt on its tab");
  now.paused = true; now.shown = false;
  eq(true, binding.admits(now), "provider unlock pauses the host; the open prompt keeps its binding");
  now.paused = false; now.shown = true; now.navigation = 8;
  eq(false, binding.admits(now), "a new navigation invalidates the binding");
  BrowserHttpAuthOrigin.Binding signingIn = new BrowserHttpAuthOrigin.Binding("https://example.com", 7);
  signingIn.submitted();
  eq(true, signingIn.admits(now), "after Sign in, the site's answer may navigate the same tab until the host resolves it");
  now.navigation = 6;
  eq(false, signingIn.admits(now), "never an older navigation");
  signingIn.revoke(); now.navigation = 8;
  eq(false, signingIn.admits(now), "resolved or dismissed: revoked");
  now.navigation = 7; now.selected = false;
  eq(false, binding.admits(now), "another tab selected");
  now.selected = true; now.closed = true;
  eq(false, binding.admits(now), "tab closed");
  now.closed = false;
  binding.revoke();
  eq(false, binding.admits(now), "cancel or dismissal revokes; late fill values are dropped");
  eq(false, binding.admits(null), "no tab");

  eq("https://example.com:8443", BrowserHttpAuthOrigin.requestOrigin("https://EXAMPLE.com:8443/x?y"), "request origin keeps a non-default port");
  eq("http://example.com", BrowserHttpAuthOrigin.requestOrigin("http://example.com:80/"), "http default port omitted");
  eq(null, BrowserHttpAuthOrigin.requestOrigin("blob:https://example.com/1"), "non-network requests have no origin");
  eq(null, BrowserHttpAuthOrigin.exactHttps("http://example.com/"), "exactHttps refuses cleartext");

  // --- No tab is fillable while a site prompt is open (canAutofill sets overlay) ---
  BrowserAutofillEligibility.TabState tab = new BrowserAutofillEligibility.TabState();
  tab.selected = true; tab.shown = true; tab.committed = true; tab.documentUrl = tab.engineUrl = "https://example.com/";
  eq(true, BrowserAutofillEligibility.eligible(tab), "committed selected tab without a prompt");
  tab.overlay = true;
  eq(false, BrowserAutofillEligibility.eligible(tab), "the same tab while the HTTP sign-in prompt is open");

  // --- The password policy with the prompt's field shape ---
  // The origin the prompt reports is exactly what bind() admitted from the engine report.
  String origin = origin(engine("https://example.com:8443/admin", "Admin", true, true, 3), tab("example.com", "Admin", "https://example.com:8443/admin", 3));
  eq("https://example.com:8443", origin, "engine-bound origin keeps its port");
  PasswordFormPolicy.Target fill = PasswordFormPolicy.evaluate(HOST, HOST, true, prompt(origin, null, null), p -> false, false);
  eq(origin, fill.webOrigin, "fill binds to the exact origin, port included");
  eq(null, fill.appPackage, "never bound to the host app identity");
  eq("f1", fill.usernameId, "username field");
  eq("f2", fill.passwordId, "password field");
  PasswordFormPolicy.Target save = PasswordFormPolicy.evaluate(HOST, HOST, true, prompt(origin, "ada", "s3cret"), p -> false, true);
  eq(origin, save.webOrigin, "save binds to the same origin");

  eq("Host interface is never filled", rejected(prompt(null, null, null), HOST, true, false), "no origin: the prompt is host UI and is refused");
  eq("Untrusted browser", rejected(prompt(origin, null, null), HOST, false, false), "a host that is not a browser");
  eq("Untrusted browser", rejected(prompt(origin, null, null), "com.example.other", true, false), "another package is not trusted");

  Node wrongField = prompt(origin, null, null); wrongField.children.get(2).fieldOrigin = "https://evil.example";
  eq("Cross-origin frame", rejected(wrongField, HOST, true, false), "wrong field origin");
  Node noField = prompt(origin, null, null); noField.children.get(2).fieldOrigin = null;
  eq("Field origin unavailable", rejected(noField, HOST, true, false), "missing field origin");
  Node frame = prompt(origin, null, null); frame.children.get(1).webDomain = "evil.example";
  eq("Cross-origin frame", rejected(frame, HOST, true, false), "a second domain");
  Node wrongTop = prompt(origin, null, null); for (Node n : wrongTop.children) if (n.topOrigin != null) n.topOrigin = "https://evil.example";
  eq("Cross-origin frame", rejected(wrongTop, HOST, true, false), "top-level origin of another host");
  Node cleartext = prompt(origin, null, null); for (Node n : cleartext.children) if (n.webScheme != null) n.webScheme = "http";
  eq("Insecure origin", rejected(cleartext, HOST, true, false), "cleartext scheme");

  // The previous username input type (VISIBLE_PASSWORD) would have made the form ambiguous.
  Node legacy = prompt(origin, null, null); legacy.children.get(1).inputType = CLASS_TEXT | TEXT_VISIBLE_PASSWORD;
  eq("Ambiguous password fields", rejected(legacy, HOST, true, false), "legacy username type");

  // --- The activity's whole structure: tab WebView window plus the prompt window ---
  // While the prompt is open the tab is ineligible, so CredentialWebView reports no children.
  Node activity = new Node(); Node tabWindow = new Node(); tabWindow.id = "tab"; activity.add(tabWindow).add(prompt(origin, null, null));
  eq(origin, PasswordFormPolicy.evaluate(HOST, HOST, true, activity, p -> false, false).webOrigin, "prompt with an excluded tab window");
  Node activitySave = new Node(); activitySave.add(new Node()).add(prompt(origin, "ada", "s3cret"));
  eq(origin, PasswordFormPolicy.evaluate(HOST, HOST, true, activitySave, p -> false, true).webOrigin, "save with an excluded tab window");
  // Why the overlay matters: a re-enabled tab adds its page's login fields to the same request.
  eq("Ambiguous password fields", rejected(withTab(origin, origin, true), HOST, true, false), "re-enabled tab, same origin");
  eq("Ambiguous password fields", rejected(withTab(origin, "https://other.example", true), HOST, true, false), "re-enabled tab, another origin");
  eq("Cross-origin frame", rejected(withTab(origin, "https://other.example", false), HOST, true, false), "re-enabled tab with only a username field");

  System.out.println(checks + " assertions passed");
 }
}
